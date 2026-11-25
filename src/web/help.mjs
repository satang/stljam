const issuePage = 'https://github.com/satang/stljam/issues/new';

function browserName() {
  const match = navigator.userAgent.match(/(EdgA?|EdgiOS|OPR|Firefox|FxiOS|CriOS|Chrome|Version)\/([\d.]+)/g);
  if (!match) return 'Unknown';
  const [id, version] = match.at(-1).split('/');
  const names = { Edg: 'Edge', EdgA: 'Edge', EdgiOS: 'Edge', OPR: 'Opera', Firefox: 'Firefox', FxiOS: 'Firefox', CriOS: 'Chrome', Chrome: 'Chrome', Version: 'Safari' };
  return `${names[id]} ${version}`;
}

export function setupHelp(api) {
  const dialog = document.getElementById('help-dialog');
  const opener = document.getElementById('help-open');
  const version = document.getElementById('help-version');
  const copy = document.getElementById('copy-system-info');
  const status = document.getElementById('help-copy-status');
  let details;

  function issueLink(id, title, body) {
    document.getElementById(id).href = `${issuePage}?${new URLSearchParams({ title, body })}`;
  }
  issueLink('report-problem', 'Bug: ', '### What happened?\n\n### What did you expect?\n\n### Steps to reproduce\n\n### System info (optional)\nPaste from Help → Copy system info.');
  issueLink('suggest-improvement', 'Suggestion: ', '### What would you like to do?\n\n### What would make it easier?');

  opener.addEventListener('click', async () => {
    status.textContent = '';
    dialog.showModal();
    if (details) return;
    try {
      details = await api('/api/info');
      version.textContent = `Version ${details.version}`;
      copy.disabled = false;
    } catch {
      version.textContent = 'Installed version unavailable';
    }
  });

  copy.addEventListener('click', async () => {
    const platforms = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };
    const text = [
      `StlJam: ${details.version}`,
      `Node.js: ${details.node}`,
      `Operating system: ${platforms[details.platform] ?? details.platform}`,
      `Browser: ${browserName()}`
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      status.textContent = 'System info copied.';
    } catch {
      status.textContent = 'Clipboard unavailable.';
    }
  });
}
