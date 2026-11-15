// Hidden page the service worker opens while it saves a PDF. A worker has no URL.createObjectURL,
// so it posts the PDF Blob here and gets a blob: URL back for chrome.downloads. The page holds no
// state and the worker closes it once the download has started. A classic script without imports,
// so it runs before the worker can post to it.
navigator.serviceWorker.onmessage = (e) => {
  const msg = e.data;
  const port = e.ports[0];
  if (!msg || msg.type !== 'ps:blob-url' || !port) return;
  try {
    port.postMessage({ ok: true, url: URL.createObjectURL(msg.blob) });
  } catch (err) {
    port.postMessage({ ok: false, error: String((err && err.message) || err) });
  }
};
