# Security policy

## Supported versions

Only the latest release on the `main` branch gets security fixes.

## Report a vulnerability

Do not open a public issue for a security problem. Instead,
[open a private report](https://github.com/mahakeerthi/web-snap-to-pdf/security/advisories/new)
through GitHub's private vulnerability reporting. Only you and the maintainers can see the report.

Include the Web Snap PDF version, the Chrome version, the steps to reproduce, and what an attacker
could do with the problem. A public page or a small HTML file that triggers it helps most.

## Scope

The extension holds the `debugger` permission and injects a content script into the tabs you act
on. These problems are in scope:

- A web page that can start an export, send messages to the extension, or read its data without
  your action.
- Anything that sends page content, settings, or files off your device.
- A way to run code in the extension's pages or its service worker.

The "Web Snap PDF started debugging this browser" bar is not a vulnerability. Chrome shows it for
every extension that attaches `chrome.debugger`, and the README explains it.
