import ipaddress
import json
import os
import re
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import uuid
import zipfile
from pathlib import Path


SQLCMD_VERSION = "1.6.0"
FIREWALL_ERROR = re.compile(r"Client with IP address '([^']+)' is not allowed to access the server\.", re.IGNORECASE)


def run(args):
    return subprocess.run(args, check=True, text=True, capture_output=True).stdout


def install_sqlcmd(directory):
    windows = os.environ.get("RUNNER_OS") == "Windows"
    platform = "windows-x64.zip" if windows else "linux-x64.tar.bz2"
    binary = "sqlcmd.exe" if windows else "sqlcmd"
    url = f"https://github.com/microsoft/go-sqlcmd/releases/download/v{SQLCMD_VERSION}/sqlcmd-v{SQLCMD_VERSION}-{platform}"
    archive_path = Path(directory) / platform
    urllib.request.urlretrieve(url, archive_path)
    if windows:
        with zipfile.ZipFile(archive_path) as archive:
            data = archive.read(binary)
    else:
        with tarfile.open(archive_path, "r:bz2") as archive:
            member = archive.extractfile(binary)
            if member is None:
                raise RuntimeError("sqlcmd executable missing from archive")
            data = member.read()
    executable = Path(directory) / binary
    executable.write_bytes(data)
    executable.chmod(0o755)
    return str(executable)


def probe(sqlcmd, server, database):
    result = subprocess.run(
        [sqlcmd, "-S", f"{server},1433", "-d", database,
         "--authentication-method=ActiveDirectoryDefault", "-Q", "SELECT 1"],
        text=True, capture_output=True,
    )
    return interpret_probe(result)


def interpret_probe(result):
    if result.returncode == 0:
        return None, None
    output = result.stdout + "\n" + result.stderr
    match = FIREWALL_ERROR.search(output)
    if match:
        address = str(ipaddress.IPv4Address(match.group(1)))
        return address, None
    return None, output


def probe_sqlpackage(server, database, directory):
    connection = f"Server=tcp:{server};Authentication=Active Directory Default;Database={database};"
    result = subprocess.run(
        ["sqlpackage", "/Action:Extract", f"/SourceConnectionString:{connection}",
         f"/TargetFile:{Path(directory) / 'probe.dacpac'}"],
        text=True, capture_output=True,
    )
    return interpret_probe(result)


def create():
    server = os.environ["SQL_SERVER_FQDN"]
    database = os.environ["SQL_DATABASE_NAME"]
    with tempfile.TemporaryDirectory(dir=os.environ.get("RUNNER_TEMP")) as directory:
        sqlcmd = install_sqlcmd(directory)
        address, error = probe(sqlcmd, server, "master")
        if error is not None:
            address, error = probe(sqlcmd, server, database)
        if error is not None:
            sqlcmd_error = error
            address, error = probe_sqlpackage(server, database, directory)
            if error is not None:
                raise RuntimeError(f"Unable to check SQL connectivity:\n{sqlcmd_error}\n{error}")
        if address is None:
            print("SQL server is already accessible; no firewall rule needed.")
            return

    servers = json.loads(run(["az", "sql", "server", "list", "--output", "json"]))
    matches = [item for item in servers if item["fullyQualifiedDomainName"].lower() == server.lower()]
    if len(matches) != 1:
        raise RuntimeError(f"Expected one SQL server matching {server}, found {len(matches)}.")
    resource = matches[0]
    name = f"GitHubActions_{uuid.uuid4().hex}"
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
        output.write(f"server={resource['name']}\nresource-group={resource['resourceGroup']}\nrule-name={name}\n")
    print(f"Adding temporary SQL firewall rule for {address}.", flush=True)
    run(["az", "sql", "server", "firewall-rule", "create", "--resource-group", resource["resourceGroup"],
         "--server", resource["name"], "--name", name, "--start-ip-address", address, "--end-ip-address", address])


def delete():
    print("Removing temporary SQL firewall rule.", flush=True)
    run(["az", "sql", "server", "firewall-rule", "delete", "--resource-group", os.environ["SQL_FIREWALL_RESOURCE_GROUP"],
         "--server", os.environ["SQL_FIREWALL_SERVER"], "--name", os.environ["SQL_FIREWALL_RULE_NAME"]])


if __name__ == "__main__":
    try:
        {"create": create, "delete": delete}[sys.argv[1]]()
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"::error::{error}", file=sys.stderr)
        if isinstance(error, subprocess.CalledProcessError) and error.stderr:
            print(error.stderr, file=sys.stderr)
        sys.exit(1)
