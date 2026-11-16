# One long-lived Python process holding a mobilerun_core Device for the eval's Mobilerun adapter
# (mobilerun.ts). It reads one JSON request per line on stdin and answers one JSON line on stdout.
# Each op is a call mobile-harness's iOS guide (platforms/ios/GUIDE.md) tells an agent to make.
# Keeping one process gives Mobilerun the benefit of the doubt: the harness runs a fresh Python
# process per step, which adds interpreter start-up and a new connection to every call.
import json
import sys
import time

from mobilerun_core import Mobilerun

url = sys.argv[1]
device = Mobilerun().connect(backend="local-ios-http", url=url)
last = {}  # ref -> node from the most recent ui(), as an agent keeps the nodes it printed


def label_of(node):
    return (
        node.get("text")
        or node.get("contentDescription")
        or node.get("accessibilityIdentifier")
        or node.get("resourceId")
        or ""
    )


def op_ui(_args):
    state = device.ui()
    last.clear()
    elements = []
    for i, node in enumerate(state.nodes):
        ref = f"n{i}"
        last[ref] = node
        b = node.get("bounds") or None
        elements.append(
            {
                "ref": ref,
                "role": node.get("type") or node.get("className") or "",
                "label": label_of(node),
                "value": node.get("value"),
                "rect": {"x": b["x"], "y": b["y"], "w": b["width"], "h": b["height"]} if b else None,
            }
        )
    # What an agent prints to read the screen: the tree as JSON.
    # dead_tree: the tool's own "no tree available" signal, which device.ui() says to check before
    # trusting an empty screen.
    return {
        "elements": elements,
        "text": json.dumps(state.get("a11y_tree"), ensure_ascii=False),
        "dead": bool(state.dead_tree),
    }


def op_tap_ref(args):
    node = last.get(args["ref"])
    if node is None:
        raise KeyError(f"no node {args['ref']} in the last ui()")
    device.tap_node(node)
    return "tapped node"


def op_tap_text(args):
    device.tap_text(args["text"])
    return f"tapped {args['text']!r}"


def op_scroll_to_and_tap(args):
    node = device.scroll_until(text_contains=args["text"], direction="down")
    if node is None:
        raise LookupError(f"scroll_until found no {args['text']!r}")
    device.tap_node(node)
    return f"scrolled to and tapped {args['text']!r}"


def op_tap(args):
    device.tap(int(args["x"]), int(args["y"]))
    return f"tapped ({args['x']}, {args['y']})"


def op_fill(args):
    device.tap_text(args["field"])
    device.type(args["text"], clear=True)
    return f"typed into {args['field']!r}"


def op_tap_switch(args):
    # The harness's way to a control: find_nodes, then tap_node.
    nodes = [n for n in device.find_nodes(any_contains=args["label"]) if n.get("type") == "Switch"]
    if not nodes:
        raise LookupError(f"no Switch matching {args['label']!r}")
    node = nodes[0]
    is_on = node.get("value") in ("1", "true", "on")
    if is_on == args["on"]:
        return f"already {'on' if is_on else 'off'}"
    device.tap_node(node)
    return "tapped switch"


def op_start_app(args):
    device.start_app(args["bundle"])
    return f"started {args['bundle']}"


OPS = {
    "ui": op_ui,
    "tap_ref": op_tap_ref,
    "tap_text": op_tap_text,
    "scroll_to_and_tap": op_scroll_to_and_tap,
    "tap": op_tap,
    "fill": op_fill,
    "tap_switch": op_tap_switch,
    "start_app": op_start_app,
}

print(json.dumps({"ready": True}), flush=True)
for line in sys.stdin:
    req = json.loads(line)
    t0 = time.time()
    try:
        result = OPS[req["op"]](req.get("args") or {})
        out = {"id": req["id"], "ok": True, "result": result}
    except Exception as e:  # the tool's own error, reported as the agent would see it
        out = {"id": req["id"], "ok": False, "error": f"{type(e).__name__}: {e}"}
    out["ms"] = round((time.time() - t0) * 1000)
    print(json.dumps(out, ensure_ascii=False), flush=True)
