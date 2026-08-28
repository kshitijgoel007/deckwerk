/**
 * Compare two BGRA bitmaps while allowing rasterizers to place an
 * anti-aliased edge within one CSS-pixel fringe. Large fills, missing content,
 * and movement beyond that fringe remain differences.
 */
function comparePixelBuffers(reference, actual, width, height, options = {}) {
  const channelTolerance = options.channelTolerance ?? 24;
  const edgeChannelTolerance = options.edgeChannelTolerance ?? channelTolerance;
  const highToleranceAreas = options.highToleranceAreas ?? [];
  const radius = options.radius ?? 1;
  if (reference.length !== actual.length || reference.length !== width * height * 4) {
    throw new Error('Bitmap dimensions do not match the supplied buffers');
  }
  const toleranceMap = highToleranceAreas.length > 0
    ? new Uint8Array(width * height).fill(channelTolerance)
    : null;
  const radiusMap = highToleranceAreas.some((area) => area.radius !== undefined)
    ? new Uint8Array(width * height).fill(radius)
    : null;
  for (const area of highToleranceAreas) {
    const minX = Math.max(0, Math.floor(area.x));
    const maxX = Math.min(width, Math.ceil(area.x + area.w));
    const minY = Math.max(0, Math.floor(area.y));
    const maxY = Math.min(height, Math.ceil(area.y + area.h));
    for (let y = minY; y < maxY; y++) {
      for (let x = minX; x < maxX; x++) {
        const pixel = y * width + x;
        toleranceMap[pixel] = Math.max(toleranceMap[pixel], area.channelTolerance);
        if (radiusMap && area.radius !== undefined) {
          radiusMap[pixel] = Math.max(radiusMap[pixel], area.radius);
        }
      }
    }
  }
  const different = new Uint8Array(width * height);
  let differing = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixel = y * width + x;
      const offset = pixel * 4;
      const tolerance = toleranceMap?.[pixel] ?? channelTolerance;
      const spatialTolerance = radiusMap?.[pixel] ?? radius;
      if (withinTolerance(reference, offset, actual, offset, tolerance)) continue;
      if (matchesNearby(reference, offset, actual, x, y, width, height,
        spatialTolerance, tolerance)) continue;
      // The screen and PDF compositors use different antialiasing kernels.
      // Permit a larger channel delta only where either bitmap has a local
      // transition; unchanged solid fills remain subject to the strict base
      // tolerance, and missing content still exceeds the edge allowance.
      if (edgeChannelTolerance > tolerance
        && (isEdge(reference, x, y, width, height, tolerance)
          || isEdge(actual, x, y, width, height, tolerance))
        && (withinTolerance(reference, offset, actual, offset, edgeChannelTolerance)
          || matchesNearby(reference, offset, actual, x, y, width, height,
            spatialTolerance, edgeChannelTolerance))) continue;
      different[pixel] = 1;
      differing++;
    }
  }
  return { differing, total: width * height, different };
}

function isEdge(bitmap, x, y, width, height, threshold) {
  const offset = (y * width + x) * 4;
  const minY = Math.max(0, y - 1);
  const maxY = Math.min(height - 1, y + 1);
  const minX = Math.max(0, x - 1);
  const maxX = Math.min(width - 1, x + 1);
  for (let neighborY = minY; neighborY <= maxY; neighborY++) {
    for (let neighborX = minX; neighborX <= maxX; neighborX++) {
      if (neighborX === x && neighborY === y) continue;
      const neighborOffset = (neighborY * width + neighborX) * 4;
      if (!withinTolerance(bitmap, offset, bitmap, neighborOffset, threshold)) return true;
    }
  }
  return false;
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
