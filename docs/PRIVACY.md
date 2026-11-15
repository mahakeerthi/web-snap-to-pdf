# Privacy policy for WebPage to PDF

Last updated: 16 November 2026.

WebPage to PDF does not collect, transmit or sell any data. Web pages are converted to PDF, image or Markdown files locally in your browser using Chrome's built-in engine, and the files are saved only to your device. Your settings are stored with Chrome's extension storage (synced by Chrome if you use Chrome Sync). The extension makes no network requests and contains no analytics or remote code.

## What the extension does with a page

When you choose Full page, Article only or Select element, the extension reads the page in the tab you are on, shows you a preview, and saves the file you pick (PDF, PNG or JPEG, or Markdown if you turn that experimental option on) to your Downloads folder, or to the place you choose if you turn on "Ask where to save". The page content stays on your device the whole time. It is never sent to the developer or to any other server.

## What is stored

Only your export settings (paper size, margins, theme, language and similar) and small interface preferences, such as whether the export settings panel is open. Chrome keeps them in its extension storage. If you use Chrome Sync, Chrome may sync the settings between your own devices. No page content, URLs or browsing history are stored.

## Permissions

The extension asks for the permissions it needs to print and save the page and nothing more: `debugger` (Chrome's print and screenshot engine, attached to the one tab you acted on), `activeTab`, `scripting`, `downloads`, `offscreen` (a hidden page of the extension that helps save large PDFs quickly), `storage` and `contextMenus`. It requests no host permissions. The full list with the reason for each is in [store/listing.md](store/listing.md).

## Third parties

None. The extension loads no remote code, uses no analytics, advertising or tracking, and shares nothing with anyone.

## Questions

Open an issue at <https://github.com/mahakeerthi/web-snap-to-pdf/issues>.
