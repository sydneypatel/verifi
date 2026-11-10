// Phone screenshots are large (an iPhone screenshot is about 1290 x 2796 and
// several MB). Shrink before upload: the request stays far under Vercel's 4.5 MB
// cap, and the model reads text just as well at this size.

const MAX_LONG_EDGE = 1800;
const MAX_SHORT_EDGE = 1000;
const QUALITY = 0.85;

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("That file couldn't be opened as an image."));
    };
    img.src = url;
  });
}

/** An image file -> a JPEG data URL, scaled down to fit. Runs on the phone; the original never leaves it. */
export async function shrinkImage(file: Blob): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Pick an image (a screenshot of the post).');
  const img = await loadImage(file);
  const long = Math.max(img.naturalWidth, img.naturalHeight);
  const short = Math.min(img.naturalWidth, img.naturalHeight);
  const scale = Math.min(1, MAX_LONG_EDGE / long, MAX_SHORT_EDGE / short);

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error("This browser can't prepare the image.");
  // JPEG has no transparency: paint white first so transparent PNGs don't turn black.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', QUALITY);
}
