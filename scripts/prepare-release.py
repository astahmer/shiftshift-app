import json
import os
from pathlib import Path
import re
import subprocess


def select_release(*, releases, commit, minimum):
    marker = f"Source commit: {commit}"
    existing = [release for release in releases if marker in (release.get("body") or "")]
    if existing:
        return existing[0]["tag_name"], existing[0]
    versions = [tuple(map(int, match.groups())) for release in releases
                if (match := re.fullmatch(r"v(\d+)\.(\d+)\.(\d+)", release["tag_name"]))]
    baseline = tuple(map(int, minimum.split(".")))
    if versions:
        latest = max(versions)
        baseline = max(baseline, (latest[0], latest[1], latest[2] + 1))
    return "v" + ".".join(map(str, baseline)), None


def write_version(*, root, version):
    for relative in ["package.json", "src-tauri/tauri.conf.json"]:
        path = root / relative
        value = json.loads(path.read_text())
        value["version"] = version
        path.write_text(json.dumps(value, indent="\t") + "\n")
    path = root / "src-tauri/Cargo.toml"
    text, count = re.subn(r'(?m)^version = "[^"]+"$', f'version = "{version}"', path.read_text(), count=1)
    if count != 1:
        raise ValueError("Cargo package version missing")
    path.write_text(text)


def main():
    repository = os.environ["GITHUB_REPOSITORY"]
    commit = os.environ["RELEASE_COMMIT"]
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("Expected full source commit SHA")
    pages = json.loads(subprocess.check_output([
        "gh", "api", f"repos/{repository}/releases", "--paginate", "--slurp"
    ]))
    releases = [release for page in pages for release in page]
    tag, existing = select_release(releases=releases, commit=commit, minimum="0.1.1")
    if existing is None:
        payload = {
            "tag_name": tag,
            "target_commitish": commit,
            "draft": True,
            "name": f"shiftshift {tag}",
            "body": f"Source commit: {commit}\n\nAutomated macOS release. Apple code signing and notarization are not configured.",
        }
        response = subprocess.run([
            "gh", "api", f"repos/{repository}/releases", "--method", "POST", "--input", "-"
        ], input=json.dumps(payload), text=True, capture_output=True, check=True)
        existing = json.loads(response.stdout)
    version = tag.removeprefix("v")
    write_version(root=Path.cwd(), version=version)
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        output.write(f"tag={tag}\nversion={version}\nrelease_id={existing['id']}\npublished={str(not existing['draft']).lower()}\n")
    print(f"Prepared {tag} for {commit}")


if __name__ == "__main__":
    main()
