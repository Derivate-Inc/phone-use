"""phone-use traffic capture addon for mitmdump.

Runs inside mitmdump on a phone host. For every proxied flow it appends one
JSONL line to <capture dir>/flows.jsonl, attributed to the sandbox whose
simulator made the request. Attribution works at connection time (the only
moment the socket demonstrably exists): client port -> owning pid (lsof) ->
device UDID via the process's open files (every simulator process holds
paths under CoreSimulator/Devices/<UDID>/ open; environment inspection via
`ps eww` is dead on modern macOS, verified empirically) -> sandbox id via
the devices.json map the worker maintains. Processes whose own file table
lacks the path fall back to a short parent-pid walk (launchd_sim always
matches).

Design constraints, in order:
  1. NEVER break traffic. Every hook is wrapped; on any error the flow passes
     through and the line is tagged unattributed rather than dropped.
  2. Bodies are NOT captured unless PHONE_USE_CAPTURE_BODIES=1 — phones hold
     real logins, and metadata is enough for most debugging. With bodies on,
     each side is capped at 64KB and base64'd.
  3. The worker owns the map file; this addon only reads it (reloaded on
     mtime change), so worker restarts/restores need no proxy restart.

Environment:
  PHONE_USE_CAPTURE_DIR     directory holding devices.json + flows.jsonl
  PHONE_USE_CAPTURE_BODIES  "1" to include capped request/response bodies
"""

import base64
import json
import os
import re
import subprocess
import time

CAPTURE_DIR = os.environ.get("PHONE_USE_CAPTURE_DIR", "./capture")
BODIES = os.environ.get("PHONE_USE_CAPTURE_BODIES") == "1"
BODY_CAP = 64 * 1024

_map_path = os.path.join(CAPTURE_DIR, "devices.json")
_flows_path = os.path.join(CAPTURE_DIR, "flows.jsonl")
_map_mtime = 0.0
_udid_to_sandbox = {}
# client peername -> (udid, sandbox) resolved once per connection
_conn_attribution = {}


def _load_map():
    global _map_mtime, _udid_to_sandbox
    try:
        mtime = os.stat(_map_path).st_mtime
        if mtime != _map_mtime:
            with open(_map_path) as f:
                _udid_to_sandbox = json.load(f)
            _map_mtime = mtime
    except Exception:
        pass


_UDID_RE = re.compile(r"Devices/([0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12})/")
_pid_udid_cache = {}


def _pid_udid(pid):
    """pid -> simulator UDID via its open-file paths; cached per pid."""
    if pid in _pid_udid_cache:
        return _pid_udid_cache[pid]
    udid = None
    try:
        out = subprocess.run(
            ["lsof", "-a", "-p", pid, "-Fn"], capture_output=True, text=True, timeout=3
        ).stdout
        match = _UDID_RE.search(out)
        udid = match.group(1) if match else None
    except Exception:
        pass
    if len(_pid_udid_cache) > 4096:
        _pid_udid_cache.clear()
    _pid_udid_cache[pid] = udid
    return udid


def _parent(pid):
    try:
        out = subprocess.run(
            ["ps", "-o", "ppid=", "-p", pid], capture_output=True, text=True, timeout=2
        ).stdout.strip()
        return out if out and out != "0" and out != "1" else None
    except Exception:
        return None


def _attribute(port):
    """client TCP port -> (udid, sandbox_id); (None, None) when unknown."""
    try:
        out = subprocess.run(
            ["lsof", "-nP", f"-iTCP:{port}", "-sTCP:ESTABLISHED", "-Fp"],
            capture_output=True, text=True, timeout=2,
        ).stdout
        pids = [line[1:] for line in out.splitlines() if line.startswith("p")]
        for pid in pids:
            walked = pid
            for _ in range(4):  # process itself, then a few ancestors
                udid = _pid_udid(walked)
                if udid:
                    _load_map()
                    return udid, _udid_to_sandbox.get(udid)
                walked = _parent(walked)
                if walked is None:
                    break
    except Exception:
        pass
    return None, None


def client_connected(client):
    try:
        port = client.peername[1]
        _conn_attribution[client.peername] = _attribute(port)
    except Exception:
        pass


def client_disconnected(client):
    try:
        _conn_attribution.pop(client.peername, None)
    except Exception:
        pass


def _body(content):
    if not BODIES or content is None:
        return None
    return base64.b64encode(content[:BODY_CAP]).decode()


def response(flow):
    _write(flow, error=None)


def error(flow):
    _write(flow, error=str(flow.error) if flow.error else "unknown")


def _write(flow, error):
    try:
        peer = flow.client_conn.peername
        udid, sandbox = _conn_attribution.get(peer, (None, None))
        request = flow.request
        resp = flow.response
        line = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "sandboxId": sandbox,
            "udid": udid,
            "clientPort": peer[1] if peer else None,
            "method": request.method,
            "host": request.pretty_host,
            "path": request.path[:2048],
            "status": resp.status_code if resp else None,
            "reqBytes": len(request.raw_content or b""),
            "resBytes": len(resp.raw_content or b"") if resp else 0,
            "contentType": (resp.headers.get("content-type", "")[:100] if resp else None),
            "durMs": int((flow.response.timestamp_end - flow.request.timestamp_start) * 1000)
            if resp and resp.timestamp_end and request.timestamp_start
            else None,
            "error": error,
        }
        if BODIES:
            line["reqBody"] = _body(request.raw_content)
            line["resBody"] = _body(resp.raw_content if resp else None)
        os.makedirs(CAPTURE_DIR, exist_ok=True)
        with open(_flows_path, "a") as f:
            f.write(json.dumps(line) + "\n")
    except Exception:
        pass
