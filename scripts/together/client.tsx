/** @jsxImportSource react */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import LiveView from '../../apps/web/components/LiveView';

const { id, endpoint, token } = (await (await fetch('/connection')).json()) as {
  id: string;
  endpoint: string;
  token: string;
};

/** Same verbs the agent uses. The viewer's own Home and Paste go through the
 *  native HID bridge, which on the current worker reports ok for Home without
 *  acting and times out on Paste; taps and swipes through it do work. */
async function rpc(method: string, args: unknown[] = []): Promise<void> {
  const response = await fetch(`${endpoint}/rpc`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ method, args }),
    signal: AbortSignal.timeout(30000),
  });
  const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: { message?: string } };
  if (!response.ok || !body.ok) throw new Error(body.error?.message ?? `HTTP ${response.status}`);
}

function Keys() {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const act = async (method: string, args: unknown[] = []) => {
    setBusy(true);
    setMessage('');
    try {
      await rpc(method, args);
      setMessage('Done');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Phone control failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="phone-controls">
      <div className="phone-control-buttons">
        <button type="button" className="dash-btn" disabled={busy} onClick={() => void act('home')}>
          Home
        </button>
        <button type="button" className="dash-btn" disabled={busy} onClick={() => void act('pressKey', ['return'])}>
          Return
        </button>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (text) void act('typeText', [text]).then(() => setText(''));
        }}
      >
        <input
          aria-label="Text to type on phone"
          value={text}
          maxLength={2000}
          onChange={(event) => setText(event.target.value)}
          placeholder="Type into the focused field"
        />
        <button className="dash-btn" disabled={busy || !text} type="submit">
          Type
        </button>
      </form>
      <p role="status">{busy ? 'Sending…' : message}</p>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <main className="phone-viewer together">
    <header className="phone-viewer-bar">
      <h1>
        Together <span className="dash-mono">{id}</span>
      </h1>
    </header>
    <div className="phone-viewer-screen">
      <LiveView endpoint={endpoint} token={token} interactive />
      <Keys />
    </div>
    <p className="phone-viewer-caption">You and the agent are driving the same phone.</p>
  </main>,
);
