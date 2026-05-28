import html2canvas from 'html2canvas';

async function capture(el) {
  return html2canvas(el, {
    useCORS: true,
    allowTaint: false,
    logging: false,
    // Render at native device pixel ratio for crisp HiDPI output
    scale: window.devicePixelRatio || 1,
  });
}

function triggerDownload(canvas, filename, mimeType, quality) {
  return new Promise(resolve => {
    canvas.toBlob(blob => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      resolve();
    }, mimeType, quality);
  });
}

export async function exportAsPng(mapEl) {
  const canvas = await capture(mapEl);
  await triggerDownload(canvas, 'zipmap.png', 'image/png');
}

export async function exportAsJpeg(mapEl, quality = 0.92) {
  const canvas = await capture(mapEl);
  await triggerDownload(canvas, 'zipmap.jpg', 'image/jpeg', quality);
}
