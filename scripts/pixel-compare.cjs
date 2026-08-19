/**
 * Compare two BGRA bitmaps while allowing rasterizers to place an
 * anti-aliased edge within one CSS-pixel fringe. Large fills, missing content,
 * and movement beyond that fringe remain differences.
 */
function comparePixelBuffers(reference, actual, width, height, options = {}) {
  const channelTolerance = options.channelTolerance ?? 24;
  const radius = options.radius ?? 1;
  if (reference.length !== actual.length || reference.length !== width * height * 4) {
    throw new Error('Bitmap dimensions do not match the supplied buffers');
  }
  const different = new Uint8Array(width * height);
  let differing = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixel = y * width + x;
      const offset = pixel * 4;
      if (withinTolerance(reference, offset, actual, offset, channelTolerance)) continue;
      if (matchesNearby(reference, offset, actual, x, y, width, height,
        radius, channelTolerance)) continue;
      different[pixel] = 1;
      differing++;
    }
  }
  return { differing, total: width * height, different };
}

function matchesNearby(reference, referenceOffset, actual, x, y, width, height,
  radius, channelTolerance) {
  const minY = Math.max(0, y - radius);
  const maxY = Math.min(height - 1, y + radius);
  const minX = Math.max(0, x - radius);
  const maxX = Math.min(width - 1, x + radius);
  for (let neighborY = minY; neighborY <= maxY; neighborY++) {
    for (let neighborX = minX; neighborX <= maxX; neighborX++) {
      const actualOffset = (neighborY * width + neighborX) * 4;
      if (withinTolerance(reference, referenceOffset, actual, actualOffset, channelTolerance)) {
        return true;
      }
    }
  }
  return false;
}

function withinTolerance(a, aOffset, b, bOffset, tolerance) {
  return Math.max(
    Math.abs(a[aOffset] - b[bOffset]),
    Math.abs(a[aOffset + 1] - b[bOffset + 1]),
    Math.abs(a[aOffset + 2] - b[bOffset + 2]),
  ) <= tolerance;
}

module.exports = { comparePixelBuffers };
