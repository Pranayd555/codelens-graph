// Helpers for asserting on webview HTML and running its inline script against
// a tiny fake DOM (no jsdom): enough for scripts that only use
// getElementById, element.style/textContent/innerHTML/className, click
// delegation and window 'message' events.
import * as vm from 'node:vm';

export interface ScriptTag { attrs: string; body: string; nonce: string | null; src: string | null }

export function scriptTags(html: string): ScriptTag[] {
  const tags: ScriptTag[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const attrs = m[1];
    tags.push({
      attrs,
      body: m[2],
      nonce: /\bnonce="([^"]*)"/.exec(attrs)?.[1] ?? null,
      src: /\bsrc="([^"]*)"/.exec(attrs)?.[1] ?? null,
    });
  }
  return tags;
}

// The Content-Security-Policy meta tag's directives, e.g. { 'script-src': ["'nonce-x'"] }.
export function cspDirectives(html: string): Record<string, string[]> {
  const metas = [...html.matchAll(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*>/gi)];
  if (metas.length !== 1) { throw new Error(`expected exactly one CSP meta tag, found ${metas.length}`); }
  const directives: Record<string, string[]> = {};
  for (const part of metas[0][1].split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) { directives[name] = values; }
  }
  return directives;
}

export class FakeElement {
  textContent = '';
  innerHTML = '';
  className = '';
  readonly style: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  constructor(readonly id: string) {}
}

export interface WebviewRun {
  context: vm.Context;
  elements: Map<string, FakeElement>;
  posted: any[];
  // Delivers a message from the extension (window 'message' event).
  dispatch(data: unknown): void;
  // Clicks an element carrying data-cmd="cmd".
  clickCommand(cmd: string): void;
}

// Runs a webview script with the elements whose ids appear in the HTML.
// getElementById returns null for unknown ids, as a browser would.
export function runWebviewScript(html: string, script: string): WebviewRun {
  const elements = new Map<string, FakeElement>();
  for (const m of html.matchAll(/<(\w+)\b([^>]*)\bid="([^"]+)"([^>]*)>/g)) {
    const el = new FakeElement(m[3]);
    const display = /style="[^"]*display:\s*(\w+)/.exec(m[2] + m[4]);
    if (display) { el.style.display = display[1]; }
    const cls = /class="([^"]*)"/.exec(m[2] + m[4]);
    if (cls) { el.className = cls[1]; }
    elements.set(m[3], el);
  }
  const posted: any[] = [];
  const messageListeners: ((ev: { data: unknown }) => void)[] = [];
  const clickListeners: ((ev: unknown) => void)[] = [];

  const document = {
    getElementById: (id: string) => elements.get(id) ?? null,
    addEventListener: (type: string, fn: (ev: unknown) => void) => { if (type === 'click') { clickListeners.push(fn); } },
  };
  const window = {
    addEventListener: (type: string, fn: (ev: { data: unknown }) => void) => { if (type === 'message') { messageListeners.push(fn); } },
  };
  const context = vm.createContext({
    document,
    window,
    // Cloned into this realm (as postMessage would) so deepEqual works on it.
    acquireVsCodeApi: () => ({ postMessage: (m: unknown) => { posted.push(JSON.parse(JSON.stringify(m))); } }),
  });
  vm.runInContext(script, context, { timeout: 2000 });

  return {
    context,
    elements,
    posted,
    dispatch(data) { for (const fn of messageListeners) { fn({ data }); } },
    clickCommand(cmd) {
      const target = { closest: (sel: string) => (sel === '[data-cmd]' ? { dataset: { cmd } } : null) };
      for (const fn of clickListeners) { fn({ target }); }
    },
  };
}
