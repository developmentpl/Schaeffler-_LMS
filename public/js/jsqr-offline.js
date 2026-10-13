/*!
 * jsqr-offline.js
 * Hand-ported, dependency-free, offline build of the QR decoding algorithm
 * from cozmo/jsQR (MIT License) - https://github.com/cozmo/jsQR
 *
 * This file is a faithful line-by-line port of jsQR's TypeScript source
 * (BitMatrix, binarizer, Reed-Solomon GF(256) error correction, BitStream,
 * segment decoding, version tables, decoder, perspective extractor and
 * finder-pattern locator) with only type annotations stripped and a few
 * internal names adjusted to avoid collisions when flattened into a single
 * scope. Kanji/Shift-JIS decoding (shiftJISTable.ts, ~126KB of lookup data)
 * is intentionally stubbed out since it is never needed for this
 * application's own QR codes or any realistic ASCII payload; the stub still
 * consumes the correct number of bits so stream alignment is preserved for
 * any following segments.
 *
 * Exposes a single global: window.jsQR(imageData, width, height, options)
 * Usage matches the upstream library:
 *   const code = jsQR(imageData.data, imageData.width, imageData.height);
 *   if (code) { console.log(code.data); }
 */
(function (global) {
  "use strict";

  // =========================================================================
  // BitMatrix
  // =========================================================================
  class BitMatrix {
    static createEmpty(width, height) {
      return new BitMatrix(new Uint8ClampedArray(width * height), width);
    }

    constructor(data, width) {
      this.width = width;
      this.height = data.length / width;
      this.data = data;
    }

    get(x, y) {
      if (x < 0 || x >= this.width || y < 0 || y >= this.height) {
        return false;
      }
      return !!this.data[y * this.width + x];
    }

    set(x, y, v) {
      this.data[y * this.width + x] = v ? 1 : 0;
    }

    setRegion(left, top, width, height, v) {
      for (let y = top; y < top + height; y++) {
        for (let x = left; x < left + width; x++) {
          this.set(x, y, !!v);
        }
      }
    }
  }

  // =========================================================================
  // Binarizer (greyscale conversion + adaptive block thresholding)
  // =========================================================================
  const REGION_SIZE = 8;
  const MIN_DYNAMIC_RANGE = 24;

  function numBetween(value, min, max) {
    return value < min ? min : value > max ? max : value;
  }

  // Like BitMatrix but accepts arbitrary Uint8 values (greyscale luminance / block averages)
  class GreyMatrix {
    constructor(width, height) {
      this.width = width;
      this.data = new Uint8ClampedArray(width * height);
    }
    get(x, y) {
      return this.data[y * this.width + x];
    }
    set(x, y, value) {
      this.data[y * this.width + x] = value;
    }
  }

  function binarize(data, width, height, returnInverted) {
    if (data.length !== width * height * 4) {
      throw new Error("Malformed data passed to binarizer.");
    }
    // Convert image to greyscale
    const greyscalePixels = new GreyMatrix(width, height);
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        const r = data[(y * width + x) * 4 + 0];
        const g = data[(y * width + x) * 4 + 1];
        const b = data[(y * width + x) * 4 + 2];
        greyscalePixels.set(x, y, 0.2126 * r + 0.7152 * g + 0.0722 * b);
      }
    }
    const horizontalRegionCount = Math.ceil(width / REGION_SIZE);
    const verticalRegionCount = Math.ceil(height / REGION_SIZE);

    const blackPoints = new GreyMatrix(horizontalRegionCount, verticalRegionCount);
    for (let verticalRegion = 0; verticalRegion < verticalRegionCount; verticalRegion++) {
      for (let hortizontalRegion = 0; hortizontalRegion < horizontalRegionCount; hortizontalRegion++) {
        let sum = 0;
        let min = Infinity;
        let max = 0;
        for (let y = 0; y < REGION_SIZE; y++) {
          for (let x = 0; x < REGION_SIZE; x++) {
            const pixelLumosity = greyscalePixels.get(
              hortizontalRegion * REGION_SIZE + x,
              verticalRegion * REGION_SIZE + y
            );
            sum += pixelLumosity;
            min = Math.min(min, pixelLumosity);
            max = Math.max(max, pixelLumosity);
          }
        }

        let average = sum / REGION_SIZE ** 2;
        if (max - min <= MIN_DYNAMIC_RANGE) {
          // Low-contrast block: assume it is entirely one shade. Default the black point to half
          // the min - effectively whiting it out - then correct using neighboring blocks.
          average = min / 2;

          if (verticalRegion > 0 && hortizontalRegion > 0) {
            const averageNeighborBlackPoint =
              (blackPoints.get(hortizontalRegion, verticalRegion - 1) +
                2 * blackPoints.get(hortizontalRegion - 1, verticalRegion) +
                blackPoints.get(hortizontalRegion - 1, verticalRegion - 1)) /
              4;
            if (min < averageNeighborBlackPoint) {
              average = averageNeighborBlackPoint;
            }
          }
        }
        blackPoints.set(hortizontalRegion, verticalRegion, average);
      }
    }

    const binarized = BitMatrix.createEmpty(width, height);
    let inverted = null;
    if (returnInverted) {
      inverted = BitMatrix.createEmpty(width, height);
    }
    for (let verticalRegion = 0; verticalRegion < verticalRegionCount; verticalRegion++) {
      for (let hortizontalRegion = 0; hortizontalRegion < horizontalRegionCount; hortizontalRegion++) {
        const left = numBetween(hortizontalRegion, 2, horizontalRegionCount - 3);
        const top = numBetween(verticalRegion, 2, verticalRegionCount - 3);
        let sum = 0;
        for (let xRegion = -2; xRegion <= 2; xRegion++) {
          for (let yRegion = -2; yRegion <= 2; yRegion++) {
            sum += blackPoints.get(left + xRegion, top + yRegion);
          }
        }
        const threshold = sum / 25;
        for (let xRegion = 0; xRegion < REGION_SIZE; xRegion++) {
          for (let yRegion = 0; yRegion < REGION_SIZE; yRegion++) {
            const x = hortizontalRegion * REGION_SIZE + xRegion;
            const y = verticalRegion * REGION_SIZE + yRegion;
            const lum = greyscalePixels.get(x, y);
            binarized.set(x, y, lum <= threshold);
            if (returnInverted) {
              inverted.set(x, y, !(lum <= threshold));
            }
          }
        }
      }
    }
    if (returnInverted) {
      return { binarized, inverted };
    }
    return { binarized };
  }

  // =========================================================================
  // Reed-Solomon error correction over GF(256)
  // =========================================================================
  function addOrSubtractGF(a, b) {
    return a ^ b; // eslint-disable-line no-bitwise
  }

  class GenericGF {
    constructor(primitive, size, genBase) {
      this.primitive = primitive;
      this.size = size;
      this.generatorBase = genBase;
      this.expTable = new Array(this.size);
      this.logTable = new Array(this.size);

      let x = 1;
      for (let i = 0; i < this.size; i++) {
        this.expTable[i] = x;
        x = x * 2;
        if (x >= this.size) {
          x = (x ^ this.primitive) & (this.size - 1); // eslint-disable-line no-bitwise
        }
      }

      for (let i = 0; i < this.size - 1; i++) {
        this.logTable[this.expTable[i]] = i;
      }
      this.zero = new GenericGFPoly(this, Uint8ClampedArray.from([0]));
      this.one = new GenericGFPoly(this, Uint8ClampedArray.from([1]));
    }

    multiply(a, b) {
      if (a === 0 || b === 0) {
        return 0;
      }
      return this.expTable[(this.logTable[a] + this.logTable[b]) % (this.size - 1)];
    }

    inverse(a) {
      if (a === 0) {
        throw new Error("Can't invert 0");
      }
      return this.expTable[this.size - this.logTable[a] - 1];
    }

    buildMonomial(degree, coefficient) {
      if (degree < 0) {
        throw new Error("Invalid monomial degree less than 0");
      }
      if (coefficient === 0) {
        return this.zero;
      }
      const coefficients = new Uint8ClampedArray(degree + 1);
      coefficients[0] = coefficient;
      return new GenericGFPoly(this, coefficients);
    }

    log(a) {
      if (a === 0) {
        throw new Error("Can't take log(0)");
      }
      return this.logTable[a];
    }

    exp(a) {
      return this.expTable[a];
    }
  }

  class GenericGFPoly {
    constructor(field, coefficients) {
      if (coefficients.length === 0) {
        throw new Error("No coefficients.");
      }
      this.field = field;
      const coefficientsLength = coefficients.length;
      if (coefficientsLength > 1 && coefficients[0] === 0) {
        let firstNonZero = 1;
        while (firstNonZero < coefficientsLength && coefficients[firstNonZero] === 0) {
          firstNonZero++;
        }
        if (firstNonZero === coefficientsLength) {
          this.coefficients = field.zero.coefficients;
        } else {
          this.coefficients = new Uint8ClampedArray(coefficientsLength - firstNonZero);
          for (let i = 0; i < this.coefficients.length; i++) {
            this.coefficients[i] = coefficients[firstNonZero + i];
          }
        }
      } else {
        this.coefficients = coefficients;
      }
    }

    degree() {
      return this.coefficients.length - 1;
    }

    isZero() {
      return this.coefficients[0] === 0;
    }

    getCoefficient(degree) {
      return this.coefficients[this.coefficients.length - 1 - degree];
    }

    addOrSubtract(other) {
      if (this.isZero()) {
        return other;
      }
      if (other.isZero()) {
        return this;
      }

      let smallerCoefficients = this.coefficients;
      let largerCoefficients = other.coefficients;
      if (smallerCoefficients.length > largerCoefficients.length) {
        const tmp = smallerCoefficients;
        smallerCoefficients = largerCoefficients;
        largerCoefficients = tmp;
      }
      const sumDiff = new Uint8ClampedArray(largerCoefficients.length);
      const lengthDiff = largerCoefficients.length - smallerCoefficients.length;
      for (let i = 0; i < lengthDiff; i++) {
        sumDiff[i] = largerCoefficients[i];
      }

      for (let i = lengthDiff; i < largerCoefficients.length; i++) {
        sumDiff[i] = addOrSubtractGF(smallerCoefficients[i - lengthDiff], largerCoefficients[i]);
      }

      return new GenericGFPoly(this.field, sumDiff);
    }

    multiply(scalar) {
      if (scalar === 0) {
        return this.field.zero;
      }
      if (scalar === 1) {
        return this;
      }
      const size = this.coefficients.length;
      const product = new Uint8ClampedArray(size);
      for (let i = 0; i < size; i++) {
        product[i] = this.field.multiply(this.coefficients[i], scalar);
      }

      return new GenericGFPoly(this.field, product);
    }

    multiplyPoly(other) {
      if (this.isZero() || other.isZero()) {
        return this.field.zero;
      }
      const aCoefficients = this.coefficients;
      const aLength = aCoefficients.length;
      const bCoefficients = other.coefficients;
      const bLength = bCoefficients.length;
      const product = new Uint8ClampedArray(aLength + bLength - 1);
      for (let i = 0; i < aLength; i++) {
        const aCoeff = aCoefficients[i];
        for (let j = 0; j < bLength; j++) {
          product[i + j] = addOrSubtractGF(product[i + j], this.field.multiply(aCoeff, bCoefficients[j]));
        }
      }
      return new GenericGFPoly(this.field, product);
    }

    multiplyByMonomial(degree, coefficient) {
      if (degree < 0) {
        throw new Error("Invalid degree less than 0");
      }
      if (coefficient === 0) {
        return this.field.zero;
      }
      const size = this.coefficients.length;
      const product = new Uint8ClampedArray(size + degree);
      for (let i = 0; i < size; i++) {
        product[i] = this.field.multiply(this.coefficients[i], coefficient);
      }
      return new GenericGFPoly(this.field, product);
    }

    evaluateAt(a) {
      let result = 0;
      if (a === 0) {
        return this.getCoefficient(0);
      }
      const size = this.coefficients.length;
      if (a === 1) {
        this.coefficients.forEach((coefficient) => {
          result = addOrSubtractGF(result, coefficient);
        });
        return result;
      }
      result = this.coefficients[0];
      for (let i = 1; i < size; i++) {
        result = addOrSubtractGF(this.field.multiply(a, result), this.coefficients[i]);
      }
      return result;
    }
  }

  function runEuclideanAlgorithm(field, a, b, R) {
    // Assume a's degree is >= b's
    if (a.degree() < b.degree()) {
      const tmp = a;
      a = b;
      b = tmp;
    }

    let rLast = a;
    let r = b;
    let tLast = field.zero;
    let t = field.one;

    while (r.degree() >= R / 2) {
      const rLastLast = rLast;
      const tLastLast = tLast;
      rLast = r;
      tLast = t;

      if (rLast.isZero()) {
        return null;
      }
      r = rLastLast;
      let q = field.zero;
      const denominatorLeadingTerm = rLast.getCoefficient(rLast.degree());
      const dltInverse = field.inverse(denominatorLeadingTerm);
      while (r.degree() >= rLast.degree() && !r.isZero()) {
        const degreeDiff = r.degree() - rLast.degree();
        const scale = field.multiply(r.getCoefficient(r.degree()), dltInverse);
        q = q.addOrSubtract(field.buildMonomial(degreeDiff, scale));
        r = r.addOrSubtract(rLast.multiplyByMonomial(degreeDiff, scale));
      }

      t = q.multiplyPoly(tLast).addOrSubtract(tLastLast);

      if (r.degree() >= rLast.degree()) {
        return null;
      }
    }

    const sigmaTildeAtZero = t.getCoefficient(0);
    if (sigmaTildeAtZero === 0) {
      return null;
    }

    const inverse = field.inverse(sigmaTildeAtZero);
    return [t.multiply(inverse), r.multiply(inverse)];
  }

  function findErrorLocations(field, errorLocator) {
    const numErrors = errorLocator.degree();
    if (numErrors === 1) {
      return [errorLocator.getCoefficient(1)];
    }
    const result = new Array(numErrors);
    let errorCount = 0;
    for (let i = 1; i < field.size && errorCount < numErrors; i++) {
      if (errorLocator.evaluateAt(i) === 0) {
        result[errorCount] = field.inverse(i);
        errorCount++;
      }
    }
    if (errorCount !== numErrors) {
      return null;
    }
    return result;
  }

  function findErrorMagnitudes(field, errorEvaluator, errorLocations) {
    const s = errorLocations.length;
    const result = new Array(s);
    for (let i = 0; i < s; i++) {
      const xiInverse = field.inverse(errorLocations[i]);
      let denominator = 1;
      for (let j = 0; j < s; j++) {
        if (i !== j) {
          denominator = field.multiply(denominator, addOrSubtractGF(1, field.multiply(errorLocations[j], xiInverse)));
        }
      }
      result[i] = field.multiply(errorEvaluator.evaluateAt(xiInverse), field.inverse(denominator));
      if (field.generatorBase !== 0) {
        result[i] = field.multiply(result[i], xiInverse);
      }
    }
    return result;
  }

  function rsDecode(bytes, twoS) {
    const outputBytes = new Uint8ClampedArray(bytes.length);
    outputBytes.set(bytes);

    const field = new GenericGF(0x011d, 256, 0); // x^8 + x^4 + x^3 + x^2 + 1
    const poly = new GenericGFPoly(field, outputBytes);

    const syndromeCoefficients = new Uint8ClampedArray(twoS);
    let error = false;
    for (let s = 0; s < twoS; s++) {
      const evaluation = poly.evaluateAt(field.exp(s + field.generatorBase));
      syndromeCoefficients[syndromeCoefficients.length - 1 - s] = evaluation;
      if (evaluation !== 0) {
        error = true;
      }
    }
    if (!error) {
      return outputBytes;
    }

    const syndrome = new GenericGFPoly(field, syndromeCoefficients);

    const sigmaOmega = runEuclideanAlgorithm(field, field.buildMonomial(twoS, 1), syndrome, twoS);
    if (sigmaOmega === null) {
      return null;
    }

    const errorLocations = findErrorLocations(field, sigmaOmega[0]);
    if (errorLocations == null) {
      return null;
    }

    const errorMagnitudes = findErrorMagnitudes(field, sigmaOmega[1], errorLocations);
    for (let i = 0; i < errorLocations.length; i++) {
      const position = outputBytes.length - 1 - field.log(errorLocations[i]);
      if (position < 0) {
        return null;
      }
      outputBytes[position] = addOrSubtractGF(outputBytes[position], errorMagnitudes[i]);
    }

    return outputBytes;
  }

  // =========================================================================
  // BitStream
  // =========================================================================
  class BitStream {
    constructor(bytes) {
      this.bytes = bytes;
      this.byteOffset = 0;
      this.bitOffset = 0;
    }

    readBits(numBits) {
      if (numBits < 1 || numBits > 32 || numBits > this.available()) {
        throw new Error("Cannot read " + numBits.toString() + " bits");
      }

      let result = 0;
      if (this.bitOffset > 0) {
        const bitsLeft = 8 - this.bitOffset;
        const toRead = numBits < bitsLeft ? numBits : bitsLeft;
        const bitsToNotRead = bitsLeft - toRead;
        const mask = (0xff >> (8 - toRead)) << bitsToNotRead;
        result = (this.bytes[this.byteOffset] & mask) >> bitsToNotRead;
        numBits -= toRead;
        this.bitOffset += toRead;
        if (this.bitOffset === 8) {
          this.bitOffset = 0;
          this.byteOffset++;
        }
      }

      if (numBits > 0) {
        while (numBits >= 8) {
          result = (result << 8) | (this.bytes[this.byteOffset] & 0xff);
          this.byteOffset++;
          numBits -= 8;
        }

        if (numBits > 0) {
          const bitsToNotRead = 8 - numBits;
          const mask = (0xff >> bitsToNotRead) << bitsToNotRead;
          result = (result << numBits) | ((this.bytes[this.byteOffset] & mask) >> bitsToNotRead);
          this.bitOffset += numBits;
        }
      }
      return result;
    }

    available() {
      return 8 * (this.bytes.length - this.byteOffset) - this.bitOffset;
    }
  }

  // =========================================================================
  // Data segment decoding (Numeric / Alphanumeric / Byte / Kanji-stub / ECI)
  // =========================================================================
  const Mode = {
    Numeric: "numeric",
    Alphanumeric: "alphanumeric",
    Byte: "byte",
    Kanji: "kanji",
    ECI: "eci",
  };

  const ModeByte = {
    Terminator: 0x0,
    Numeric: 0x1,
    Alphanumeric: 0x2,
    Byte: 0x4,
    Kanji: 0x8,
    ECI: 0x7,
  };

  function decodeNumeric(stream, size) {
    const bytes = [];
    let text = "";

    const characterCountSize = [10, 12, 14][size];
    let length = stream.readBits(characterCountSize);
    while (length >= 3) {
      const num = stream.readBits(10);
      if (num >= 1000) {
        throw new Error("Invalid numeric value above 999");
      }

      const a = Math.floor(num / 100);
      const b = Math.floor(num / 10) % 10;
      const c = num % 10;

      bytes.push(48 + a, 48 + b, 48 + c);
      text += a.toString() + b.toString() + c.toString();
      length -= 3;
    }

    if (length === 2) {
      const num = stream.readBits(7);
      if (num >= 100) {
        throw new Error("Invalid numeric value above 99");
      }

      const a = Math.floor(num / 10);
      const b = num % 10;

      bytes.push(48 + a, 48 + b);
      text += a.toString() + b.toString();
    } else if (length === 1) {
      const num = stream.readBits(4);
      if (num >= 10) {
        throw new Error("Invalid numeric value above 9");
      }

      bytes.push(48 + num);
      text += num.toString();
    }

    return { bytes, text };
  }

  const AlphanumericCharacterCodes = [
    "0", "1", "2", "3", "4", "5", "6", "7", "8",
    "9", "A", "B", "C", "D", "E", "F", "G", "H",
    "I", "J", "K", "L", "M", "N", "O", "P", "Q",
    "R", "S", "T", "U", "V", "W", "X", "Y", "Z",
    " ", "$", "%", "*", "+", "-", ".", "/", ":",
  ];

  function decodeAlphanumeric(stream, size) {
    const bytes = [];
    let text = "";

    const characterCountSize = [9, 11, 13][size];
    let length = stream.readBits(characterCountSize);
    while (length >= 2) {
      const v = stream.readBits(11);

      const a = Math.floor(v / 45);
      const b = v % 45;

      bytes.push(AlphanumericCharacterCodes[a].charCodeAt(0), AlphanumericCharacterCodes[b].charCodeAt(0));
      text += AlphanumericCharacterCodes[a] + AlphanumericCharacterCodes[b];
      length -= 2;
    }

    if (length === 1) {
      const a = stream.readBits(6);
      bytes.push(AlphanumericCharacterCodes[a].charCodeAt(0));
      text += AlphanumericCharacterCodes[a];
    }

    return { bytes, text };
  }

  function decodeByte(stream, size) {
    const bytes = [];
    let text = "";

    const characterCountSize = [8, 16, 16][size];
    const length = stream.readBits(characterCountSize);
    for (let i = 0; i < length; i++) {
      const b = stream.readBits(8);
      bytes.push(b);
    }
    try {
      text += decodeURIComponent(bytes.map((b) => "%" + ("0" + b.toString(16)).substr(-2)).join(""));
    } catch (e) {
      // failed to decode as UTF-8; leave text as-is
    }

    return { bytes, text };
  }

  // Kanji/Shift-JIS decoding is intentionally not supported offline (the lookup
  // table is ~126KB and unused by this application's ASCII-only QR payloads).
  // We still consume the correct number of bits so any following segments in a
  // hypothetical mixed-mode QR code stay correctly aligned.
  function decodeKanji(stream, size) {
    const bytes = [];
    const text = "";

    const characterCountSize = [8, 10, 12][size];
    const length = stream.readBits(characterCountSize);
    for (let i = 0; i < length; i++) {
      stream.readBits(13);
    }

    return { bytes, text };
  }

  function decodeSegments(data, version) {
    const stream = new BitStream(data);

    const size = version <= 9 ? 0 : version <= 26 ? 1 : 2;

    const result = {
      text: "",
      bytes: [],
      chunks: [],
      version,
    };

    while (stream.available() >= 4) {
      const mode = stream.readBits(4);
      if (mode === ModeByte.Terminator) {
        return result;
      } else if (mode === ModeByte.ECI) {
        if (stream.readBits(1) === 0) {
          result.chunks.push({ type: Mode.ECI, assignmentNumber: stream.readBits(7) });
        } else if (stream.readBits(1) === 0) {
          result.chunks.push({ type: Mode.ECI, assignmentNumber: stream.readBits(14) });
        } else if (stream.readBits(1) === 0) {
          result.chunks.push({ type: Mode.ECI, assignmentNumber: stream.readBits(21) });
        } else {
          result.chunks.push({ type: Mode.ECI, assignmentNumber: -1 });
        }
      } else if (mode === ModeByte.Numeric) {
        const numericResult = decodeNumeric(stream, size);
        result.text += numericResult.text;
        result.bytes.push.apply(result.bytes, numericResult.bytes);
        result.chunks.push({ type: Mode.Numeric, text: numericResult.text });
      } else if (mode === ModeByte.Alphanumeric) {
        const alphanumericResult = decodeAlphanumeric(stream, size);
        result.text += alphanumericResult.text;
        result.bytes.push.apply(result.bytes, alphanumericResult.bytes);
        result.chunks.push({ type: Mode.Alphanumeric, text: alphanumericResult.text });
      } else if (mode === ModeByte.Byte) {
        const byteResult = decodeByte(stream, size);
        result.text += byteResult.text;
        result.bytes.push.apply(result.bytes, byteResult.bytes);
        result.chunks.push({ type: Mode.Byte, bytes: byteResult.bytes, text: byteResult.text });
      } else if (mode === ModeByte.Kanji) {
        const kanjiResult = decodeKanji(stream, size);
        result.text += kanjiResult.text;
        result.bytes.push.apply(result.bytes, kanjiResult.bytes);
        result.chunks.push({ type: Mode.Kanji, bytes: kanjiResult.bytes, text: kanjiResult.text });
      }
    }

    if (stream.available() === 0 || stream.readBits(stream.available()) === 0) {
      return result;
    }
    return null;
  }

  // =========================================================================
  // QR version table (all 40 versions)
  // =========================================================================
  const VERSIONS = [
    { infoBits: null, versionNumber: 1, alignmentPatternCenters: [], errorCorrectionLevels: [
      { ecCodewordsPerBlock: 7, ecBlocks: [{ numBlocks: 1, dataCodewordsPerBlock: 19 }] },
      { ecCodewordsPerBlock: 10, ecBlocks: [{ numBlocks: 1, dataCodewordsPerBlock: 16 }] },
      { ecCodewordsPerBlock: 13, ecBlocks: [{ numBlocks: 1, dataCodewordsPerBlock: 13 }] },
      { ecCodewordsPerBlock: 17, ecBlocks: [{ numBlocks: 1, dataCodewordsPerBlock: 9 }] },
    ] },
    { infoBits: null, versionNumber: 2, alignmentPatternCenters: [6, 18], errorCorrectionLevels: [
      { ecCodewordsPerBlock: 10, ecBlocks: [{ numBlocks: 1, dataCodewordsPerBlock: 34 }] },
      { ecCodewordsPerBlock: 16, ecBlocks: [{ numBlocks: 1, dataCodewordsPerBlock: 28 }] },
      { ecCodewordsPerBlock: 22, ecBlocks: [{ numBlocks: 1, dataCodewordsPerBlock: 22 }] },
      { ecCodewordsPerBlock: 28, ecBlocks: [{ numBlocks: 1, dataCodewordsPerBlock: 16 }] },
    ] },
    { infoBits: null, versionNumber: 3, alignmentPatternCenters: [6, 22], errorCorrectionLevels: [
      { ecCodewordsPerBlock: 15, ecBlocks: [{ numBlocks: 1, dataCodewordsPerBlock: 55 }] },
      { ecCodewordsPerBlock: 26, ecBlocks: [{ numBlocks: 1, dataCodewordsPerBlock: 44 }] },
      { ecCodewordsPerBlock: 18, ecBlocks: [{ numBlocks: 2, dataCodewordsPerBlock: 17 }] },
      { ecCodewordsPerBlock: 22, ecBlocks: [{ numBlocks: 2, dataCodewordsPerBlock: 13 }] },
    ] },
    { infoBits: null, versionNumber: 4, alignmentPatternCenters: [6, 26], errorCorrectionLevels: [
      { ecCodewordsPerBlock: 20, ecBlocks: [{ numBlocks: 1, dataCodewordsPerBlock: 80 }] },
      { ecCodewordsPerBlock: 18, ecBlocks: [{ numBlocks: 2, dataCodewordsPerBlock: 32 }] },
      { ecCodewordsPerBlock: 26, ecBlocks: [{ numBlocks: 2, dataCodewordsPerBlock: 24 }] },
      { ecCodewordsPerBlock: 16, ecBlocks: [{ numBlocks: 4, dataCodewordsPerBlock: 9 }] },
    ] },
    { infoBits: null, versionNumber: 5, alignmentPatternCenters: [6, 30], errorCorrectionLevels: [
      { ecCodewordsPerBlock: 26, ecBlocks: [{ numBlocks: 1, dataCodewordsPerBlock: 108 }] },
      { ecCodewordsPerBlock: 24, ecBlocks: [{ numBlocks: 2, dataCodewordsPerBlock: 43 }] },
      { ecCodewordsPerBlock: 18, ecBlocks: [{ numBlocks: 2, dataCodewordsPerBlock: 15 }, { numBlocks: 2, dataCodewordsPerBlock: 16 }] },
      { ecCodewordsPerBlock: 22, ecBlocks: [{ numBlocks: 2, dataCodewordsPerBlock: 11 }, { numBlocks: 2, dataCodewordsPerBlock: 12 }] },
    ] },
    { infoBits: null, versionNumber: 6, alignmentPatternCenters: [6, 34], errorCorrectionLevels: [
      { ecCodewordsPerBlock: 18, ecBlocks: [{ numBlocks: 2, dataCodewordsPerBlock: 68 }] },
      { ecCodewordsPerBlock: 16, ecBlocks: [{ numBlocks: 4, dataCodewordsPerBlock: 27 }] },
      { ecCodewordsPerBlock: 24, ecBlocks: [{ numBlocks: 4, dataCodewordsPerBlock: 19 }] },
      { ecCodewordsPerBlock: 28, ecBlocks: [{ numBlocks: 4, dataCodewordsPerBlock: 15 }] },
    ] },
    { infoBits: 0x07c94, versionNumber: 7, alignmentPatternCenters: [6, 22, 38], errorCorrectionLevels: [
      { ecCodewordsPerBlock: 20, ecBlocks: [{ numBlocks: 2, dataCodewordsPerBlock: 78 }] },
      { ecCodewordsPerBlock: 18, ecBlocks: [{ numBlocks: 4, dataCodewordsPerBlock: 31 }] },
      { ecCodewordsPerBlock: 18, ecBlocks: [{ numBlocks: 2, dataCodewordsPerBlock: 14 }, { numBlocks: 4, dataCodewordsPerBlock: 15 }] },
      { ecCodewordsPerBlock: 26, ecBlocks: [{ numBlocks: 4, dataCodewordsPerBlock: 13 }, { numBlocks: 1, dataCodewordsPerBlock: 14 }] },
    ] },
    { infoBits: 0x085bc, versionNumber: 8, alignmentPatternCenters: [6, 24, 42], errorCorrectionLevels: [
      { ecCodewordsPerBlock: 24, ecBlocks: [{ numBlocks: 2, dataCodewordsPerBlock: 97 }] },
      { ecCodewordsPerBlock: 22, ecBlocks: [{ numBlocks: 2, dataCodewordsPerBlock: 38 }, { numBlocks: 2, dataCodewordsPerBlock: 39 }] },
      { ecCodewordsPerBlock: 22, ecBlocks: [{ numBlocks: 4, dataCodewordsPerBlock: 18 }, { numBlocks: 2, dataCodewordsPerBlock: 19 }] },
      { ecCodewordsPerBlock: 26, ecBlocks: [{ numBlocks: 4, dataCodewordsPerBlock: 14 }, { numBlocks: 2, dataCodewordsPerBlock: 15 }] },
    ] },
    { infoBits: 0x09a99, versionNumber: 9, alignmentPatternCenters: [6, 26, 46], errorCorrectionLevels: [
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 2, dataCodewordsPerBlock: 116 }] },
      { ecCodewordsPerBlock: 22, ecBlocks: [{ numBlocks: 3, dataCodewordsPerBlock: 36 }, { numBlocks: 2, dataCodewordsPerBlock: 37 }] },
      { ecCodewordsPerBlock: 20, ecBlocks: [{ numBlocks: 4, dataCodewordsPerBlock: 16 }, { numBlocks: 4, dataCodewordsPerBlock: 17 }] },
      { ecCodewordsPerBlock: 24, ecBlocks: [{ numBlocks: 4, dataCodewordsPerBlock: 12 }, { numBlocks: 4, dataCodewordsPerBlock: 13 }] },
    ] },
    { infoBits: 0x0a4d3, versionNumber: 10, alignmentPatternCenters: [6, 28, 50], errorCorrectionLevels: [
      { ecCodewordsPerBlock: 18, ecBlocks: [{ numBlocks: 2, dataCodewordsPerBlock: 68 }, { numBlocks: 2, dataCodewordsPerBlock: 69 }] },
      { ecCodewordsPerBlock: 26, ecBlocks: [{ numBlocks: 4, dataCodewordsPerBlock: 43 }, { numBlocks: 1, dataCodewordsPerBlock: 44 }] },
      { ecCodewordsPerBlock: 24, ecBlocks: [{ numBlocks: 6, dataCodewordsPerBlock: 19 }, { numBlocks: 2, dataCodewordsPerBlock: 20 }] },
      { ecCodewordsPerBlock: 28, ecBlocks: [{ numBlocks: 6, dataCodewordsPerBlock: 15 }, { numBlocks: 2, dataCodewordsPerBlock: 16 }] },
    ] },
    { infoBits: 0x0bbf6, versionNumber: 11, alignmentPatternCenters: [6, 30, 54], errorCorrectionLevels: [
      { ecCodewordsPerBlock: 20, ecBlocks: [{ numBlocks: 4, dataCodewordsPerBlock: 81 }] },
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 1, dataCodewordsPerBlock: 50 }, { numBlocks: 4, dataCodewordsPerBlock: 51 }] },
      { ecCodewordsPerBlock: 28, ecBlocks: [{ numBlocks: 4, dataCodewordsPerBlock: 22 }, { numBlocks: 4, dataCodewordsPerBlock: 23 }] },
      { ecCodewordsPerBlock: 24, ecBlocks: [{ numBlocks: 3, dataCodewordsPerBlock: 12 }, { numBlocks: 8, dataCodewordsPerBlock: 13 }] },
    ] },
    { infoBits: 0x0c762, versionNumber: 12, alignmentPatternCenters: [6, 32, 58], errorCorrectionLevels: [
      { ecCodewordsPerBlock: 24, ecBlocks: [{ numBlocks: 2, dataCodewordsPerBlock: 92 }, { numBlocks: 2, dataCodewordsPerBlock: 93 }] },
      { ecCodewordsPerBlock: 22, ecBlocks: [{ numBlocks: 6, dataCodewordsPerBlock: 36 }, { numBlocks: 2, dataCodewordsPerBlock: 37 }] },
      { ecCodewordsPerBlock: 26, ecBlocks: [{ numBlocks: 4, dataCodewordsPerBlock: 20 }, { numBlocks: 6, dataCodewordsPerBlock: 21 }] },
      { ecCodewordsPerBlock: 28, ecBlocks: [{ numBlocks: 7, dataCodewordsPerBlock: 14 }, { numBlocks: 4, dataCodewordsPerBlock: 15 }] },
    ] },
    { infoBits: 0x0d847, versionNumber: 13, alignmentPatternCenters: [6, 34, 62], errorCorrectionLevels: [
      { ecCodewordsPerBlock: 26, ecBlocks: [{ numBlocks: 4, dataCodewordsPerBlock: 107 }] },
      { ecCodewordsPerBlock: 22, ecBlocks: [{ numBlocks: 8, dataCodewordsPerBlock: 37 }, { numBlocks: 1, dataCodewordsPerBlock: 38 }] },
      { ecCodewordsPerBlock: 24, ecBlocks: [{ numBlocks: 8, dataCodewordsPerBlock: 20 }, { numBlocks: 4, dataCodewordsPerBlock: 21 }] },
      { ecCodewordsPerBlock: 22, ecBlocks: [{ numBlocks: 12, dataCodewordsPerBlock: 11 }, { numBlocks: 4, dataCodewordsPerBlock: 12 }] },
    ] },
    { infoBits: 0x0e60d, versionNumber: 14, alignmentPatternCenters: [6, 26, 46, 66], errorCorrectionLevels: [
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 3, dataCodewordsPerBlock: 115 }, { numBlocks: 1, dataCodewordsPerBlock: 116 }] },
      { ecCodewordsPerBlock: 24, ecBlocks: [{ numBlocks: 4, dataCodewordsPerBlock: 40 }, { numBlocks: 5, dataCodewordsPerBlock: 41 }] },
      { ecCodewordsPerBlock: 20, ecBlocks: [{ numBlocks: 11, dataCodewordsPerBlock: 16 }, { numBlocks: 5, dataCodewordsPerBlock: 17 }] },
      { ecCodewordsPerBlock: 24, ecBlocks: [{ numBlocks: 11, dataCodewordsPerBlock: 12 }, { numBlocks: 5, dataCodewordsPerBlock: 13 }] },
    ] },
    { infoBits: 0x0f928, versionNumber: 15, alignmentPatternCenters: [6, 26, 48, 70], errorCorrectionLevels: [
      { ecCodewordsPerBlock: 22, ecBlocks: [{ numBlocks: 5, dataCodewordsPerBlock: 87 }, { numBlocks: 1, dataCodewordsPerBlock: 88 }] },
      { ecCodewordsPerBlock: 24, ecBlocks: [{ numBlocks: 5, dataCodewordsPerBlock: 41 }, { numBlocks: 5, dataCodewordsPerBlock: 42 }] },
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 5, dataCodewordsPerBlock: 24 }, { numBlocks: 7, dataCodewordsPerBlock: 25 }] },
      { ecCodewordsPerBlock: 24, ecBlocks: [{ numBlocks: 11, dataCodewordsPerBlock: 12 }, { numBlocks: 7, dataCodewordsPerBlock: 13 }] },
    ] },
    { infoBits: 0x10b78, versionNumber: 16, alignmentPatternCenters: [6, 26, 50, 74], errorCorrectionLevels: [
      { ecCodewordsPerBlock: 24, ecBlocks: [{ numBlocks: 5, dataCodewordsPerBlock: 98 }, { numBlocks: 1, dataCodewordsPerBlock: 99 }] },
      { ecCodewordsPerBlock: 28, ecBlocks: [{ numBlocks: 7, dataCodewordsPerBlock: 45 }, { numBlocks: 3, dataCodewordsPerBlock: 46 }] },
      { ecCodewordsPerBlock: 24, ecBlocks: [{ numBlocks: 15, dataCodewordsPerBlock: 19 }, { numBlocks: 2, dataCodewordsPerBlock: 20 }] },
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 3, dataCodewordsPerBlock: 15 }, { numBlocks: 13, dataCodewordsPerBlock: 16 }] },
    ] },
    { infoBits: 0x1145d, versionNumber: 17, alignmentPatternCenters: [6, 30, 54, 78], errorCorrectionLevels: [
      { ecCodewordsPerBlock: 28, ecBlocks: [{ numBlocks: 1, dataCodewordsPerBlock: 107 }, { numBlocks: 5, dataCodewordsPerBlock: 108 }] },
      { ecCodewordsPerBlock: 28, ecBlocks: [{ numBlocks: 10, dataCodewordsPerBlock: 46 }, { numBlocks: 1, dataCodewordsPerBlock: 47 }] },
      { ecCodewordsPerBlock: 28, ecBlocks: [{ numBlocks: 1, dataCodewordsPerBlock: 22 }, { numBlocks: 15, dataCodewordsPerBlock: 23 }] },
      { ecCodewordsPerBlock: 28, ecBlocks: [{ numBlocks: 2, dataCodewordsPerBlock: 14 }, { numBlocks: 17, dataCodewordsPerBlock: 15 }] },
    ] },
    { infoBits: 0x12a17, versionNumber: 18, alignmentPatternCenters: [6, 30, 56, 82], errorCorrectionLevels: [
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 5, dataCodewordsPerBlock: 120 }, { numBlocks: 1, dataCodewordsPerBlock: 121 }] },
      { ecCodewordsPerBlock: 26, ecBlocks: [{ numBlocks: 9, dataCodewordsPerBlock: 43 }, { numBlocks: 4, dataCodewordsPerBlock: 44 }] },
      { ecCodewordsPerBlock: 28, ecBlocks: [{ numBlocks: 17, dataCodewordsPerBlock: 22 }, { numBlocks: 1, dataCodewordsPerBlock: 23 }] },
      { ecCodewordsPerBlock: 28, ecBlocks: [{ numBlocks: 2, dataCodewordsPerBlock: 14 }, { numBlocks: 19, dataCodewordsPerBlock: 15 }] },
    ] },
    { infoBits: 0x13532, versionNumber: 19, alignmentPatternCenters: [6, 30, 58, 86], errorCorrectionLevels: [
      { ecCodewordsPerBlock: 28, ecBlocks: [{ numBlocks: 3, dataCodewordsPerBlock: 113 }, { numBlocks: 4, dataCodewordsPerBlock: 114 }] },
      { ecCodewordsPerBlock: 26, ecBlocks: [{ numBlocks: 3, dataCodewordsPerBlock: 44 }, { numBlocks: 11, dataCodewordsPerBlock: 45 }] },
      { ecCodewordsPerBlock: 26, ecBlocks: [{ numBlocks: 17, dataCodewordsPerBlock: 21 }, { numBlocks: 4, dataCodewordsPerBlock: 22 }] },
      { ecCodewordsPerBlock: 26, ecBlocks: [{ numBlocks: 9, dataCodewordsPerBlock: 13 }, { numBlocks: 16, dataCodewordsPerBlock: 14 }] },
    ] },
    { infoBits: 0x149a6, versionNumber: 20, alignmentPatternCenters: [6, 34, 62, 90], errorCorrectionLevels: [
      { ecCodewordsPerBlock: 28, ecBlocks: [{ numBlocks: 3, dataCodewordsPerBlock: 107 }, { numBlocks: 5, dataCodewordsPerBlock: 108 }] },
      { ecCodewordsPerBlock: 26, ecBlocks: [{ numBlocks: 3, dataCodewordsPerBlock: 41 }, { numBlocks: 13, dataCodewordsPerBlock: 42 }] },
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 15, dataCodewordsPerBlock: 24 }, { numBlocks: 5, dataCodewordsPerBlock: 25 }] },
      { ecCodewordsPerBlock: 28, ecBlocks: [{ numBlocks: 15, dataCodewordsPerBlock: 15 }, { numBlocks: 10, dataCodewordsPerBlock: 16 }] },
    ] },
    { infoBits: 0x15683, versionNumber: 21, alignmentPatternCenters: [6, 28, 50, 72, 94], errorCorrectionLevels: [
      { ecCodewordsPerBlock: 28, ecBlocks: [{ numBlocks: 4, dataCodewordsPerBlock: 116 }, { numBlocks: 4, dataCodewordsPerBlock: 117 }] },
      { ecCodewordsPerBlock: 26, ecBlocks: [{ numBlocks: 17, dataCodewordsPerBlock: 42 }] },
      { ecCodewordsPerBlock: 28, ecBlocks: [{ numBlocks: 17, dataCodewordsPerBlock: 22 }, { numBlocks: 6, dataCodewordsPerBlock: 23 }] },
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 19, dataCodewordsPerBlock: 16 }, { numBlocks: 6, dataCodewordsPerBlock: 17 }] },
    ] },
    { infoBits: 0x168c9, versionNumber: 22, alignmentPatternCenters: [6, 26, 50, 74, 98], errorCorrectionLevels: [
      { ecCodewordsPerBlock: 28, ecBlocks: [{ numBlocks: 2, dataCodewordsPerBlock: 111 }, { numBlocks: 7, dataCodewordsPerBlock: 112 }] },
      { ecCodewordsPerBlock: 28, ecBlocks: [{ numBlocks: 17, dataCodewordsPerBlock: 46 }] },
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 7, dataCodewordsPerBlock: 24 }, { numBlocks: 16, dataCodewordsPerBlock: 25 }] },
      { ecCodewordsPerBlock: 24, ecBlocks: [{ numBlocks: 34, dataCodewordsPerBlock: 13 }] },
    ] },
    { infoBits: 0x177ec, versionNumber: 23, alignmentPatternCenters: [6, 30, 54, 74, 102], errorCorrectionLevels: [
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 4, dataCodewordsPerBlock: 121 }, { numBlocks: 5, dataCodewordsPerBlock: 122 }] },
      { ecCodewordsPerBlock: 28, ecBlocks: [{ numBlocks: 4, dataCodewordsPerBlock: 47 }, { numBlocks: 14, dataCodewordsPerBlock: 48 }] },
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 11, dataCodewordsPerBlock: 24 }, { numBlocks: 14, dataCodewordsPerBlock: 25 }] },
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 16, dataCodewordsPerBlock: 15 }, { numBlocks: 14, dataCodewordsPerBlock: 16 }] },
    ] },
    { infoBits: 0x18ec4, versionNumber: 24, alignmentPatternCenters: [6, 28, 54, 80, 106], errorCorrectionLevels: [
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 6, dataCodewordsPerBlock: 117 }, { numBlocks: 4, dataCodewordsPerBlock: 118 }] },
      { ecCodewordsPerBlock: 28, ecBlocks: [{ numBlocks: 6, dataCodewordsPerBlock: 45 }, { numBlocks: 14, dataCodewordsPerBlock: 46 }] },
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 11, dataCodewordsPerBlock: 24 }, { numBlocks: 16, dataCodewordsPerBlock: 25 }] },
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 30, dataCodewordsPerBlock: 16 }, { numBlocks: 2, dataCodewordsPerBlock: 17 }] },
    ] },
    { infoBits: 0x191e1, versionNumber: 25, alignmentPatternCenters: [6, 32, 58, 84, 110], errorCorrectionLevels: [
      { ecCodewordsPerBlock: 26, ecBlocks: [{ numBlocks: 8, dataCodewordsPerBlock: 106 }, { numBlocks: 4, dataCodewordsPerBlock: 107 }] },
      { ecCodewordsPerBlock: 28, ecBlocks: [{ numBlocks: 8, dataCodewordsPerBlock: 47 }, { numBlocks: 13, dataCodewordsPerBlock: 48 }] },
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 7, dataCodewordsPerBlock: 24 }, { numBlocks: 22, dataCodewordsPerBlock: 25 }] },
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 22, dataCodewordsPerBlock: 15 }, { numBlocks: 13, dataCodewordsPerBlock: 16 }] },
    ] },
    { infoBits: 0x1afab, versionNumber: 26, alignmentPatternCenters: [6, 30, 58, 86, 114], errorCorrectionLevels: [
      { ecCodewordsPerBlock: 28, ecBlocks: [{ numBlocks: 10, dataCodewordsPerBlock: 114 }, { numBlocks: 2, dataCodewordsPerBlock: 115 }] },
      { ecCodewordsPerBlock: 28, ecBlocks: [{ numBlocks: 19, dataCodewordsPerBlock: 46 }, { numBlocks: 4, dataCodewordsPerBlock: 47 }] },
      { ecCodewordsPerBlock: 28, ecBlocks: [{ numBlocks: 28, dataCodewordsPerBlock: 22 }, { numBlocks: 6, dataCodewordsPerBlock: 23 }] },
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 33, dataCodewordsPerBlock: 16 }, { numBlocks: 4, dataCodewordsPerBlock: 17 }] },
    ] },
    { infoBits: 0x1b08e, versionNumber: 27, alignmentPatternCenters: [6, 34, 62, 90, 118], errorCorrectionLevels: [
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 8, dataCodewordsPerBlock: 122 }, { numBlocks: 4, dataCodewordsPerBlock: 123 }] },
      { ecCodewordsPerBlock: 28, ecBlocks: [{ numBlocks: 22, dataCodewordsPerBlock: 45 }, { numBlocks: 3, dataCodewordsPerBlock: 46 }] },
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 8, dataCodewordsPerBlock: 23 }, { numBlocks: 26, dataCodewordsPerBlock: 24 }] },
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 12, dataCodewordsPerBlock: 15 }, { numBlocks: 28, dataCodewordsPerBlock: 16 }] },
    ] },
    { infoBits: 0x1cc1a, versionNumber: 28, alignmentPatternCenters: [6, 26, 50, 74, 98, 122], errorCorrectionLevels: [
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 3, dataCodewordsPerBlock: 117 }, { numBlocks: 10, dataCodewordsPerBlock: 118 }] },
      { ecCodewordsPerBlock: 28, ecBlocks: [{ numBlocks: 3, dataCodewordsPerBlock: 45 }, { numBlocks: 23, dataCodewordsPerBlock: 46 }] },
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 4, dataCodewordsPerBlock: 24 }, { numBlocks: 31, dataCodewordsPerBlock: 25 }] },
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 11, dataCodewordsPerBlock: 15 }, { numBlocks: 31, dataCodewordsPerBlock: 16 }] },
    ] },
    { infoBits: 0x1d33f, versionNumber: 29, alignmentPatternCenters: [6, 30, 54, 78, 102, 126], errorCorrectionLevels: [
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 7, dataCodewordsPerBlock: 116 }, { numBlocks: 7, dataCodewordsPerBlock: 117 }] },
      { ecCodewordsPerBlock: 28, ecBlocks: [{ numBlocks: 21, dataCodewordsPerBlock: 45 }, { numBlocks: 7, dataCodewordsPerBlock: 46 }] },
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 1, dataCodewordsPerBlock: 23 }, { numBlocks: 37, dataCodewordsPerBlock: 24 }] },
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 19, dataCodewordsPerBlock: 15 }, { numBlocks: 26, dataCodewordsPerBlock: 16 }] },
    ] },
    { infoBits: 0x1ed75, versionNumber: 30, alignmentPatternCenters: [6, 26, 52, 78, 104, 130], errorCorrectionLevels: [
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 5, dataCodewordsPerBlock: 115 }, { numBlocks: 10, dataCodewordsPerBlock: 116 }] },
      { ecCodewordsPerBlock: 28, ecBlocks: [{ numBlocks: 19, dataCodewordsPerBlock: 47 }, { numBlocks: 10, dataCodewordsPerBlock: 48 }] },
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 15, dataCodewordsPerBlock: 24 }, { numBlocks: 25, dataCodewordsPerBlock: 25 }] },
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 23, dataCodewordsPerBlock: 15 }, { numBlocks: 25, dataCodewordsPerBlock: 16 }] },
    ] },
    { infoBits: 0x1f250, versionNumber: 31, alignmentPatternCenters: [6, 30, 56, 82, 108, 134], errorCorrectionLevels: [
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 13, dataCodewordsPerBlock: 115 }, { numBlocks: 3, dataCodewordsPerBlock: 116 }] },
      { ecCodewordsPerBlock: 28, ecBlocks: [{ numBlocks: 2, dataCodewordsPerBlock: 46 }, { numBlocks: 29, dataCodewordsPerBlock: 47 }] },
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 42, dataCodewordsPerBlock: 24 }, { numBlocks: 1, dataCodewordsPerBlock: 25 }] },
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 23, dataCodewordsPerBlock: 15 }, { numBlocks: 28, dataCodewordsPerBlock: 16 }] },
    ] },
    { infoBits: 0x209d5, versionNumber: 32, alignmentPatternCenters: [6, 34, 60, 86, 112, 138], errorCorrectionLevels: [
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 17, dataCodewordsPerBlock: 115 }] },
      { ecCodewordsPerBlock: 28, ecBlocks: [{ numBlocks: 10, dataCodewordsPerBlock: 46 }, { numBlocks: 23, dataCodewordsPerBlock: 47 }] },
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 10, dataCodewordsPerBlock: 24 }, { numBlocks: 35, dataCodewordsPerBlock: 25 }] },
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 19, dataCodewordsPerBlock: 15 }, { numBlocks: 35, dataCodewordsPerBlock: 16 }] },
    ] },
    { infoBits: 0x216f0, versionNumber: 33, alignmentPatternCenters: [6, 30, 58, 86, 114, 142], errorCorrectionLevels: [
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 17, dataCodewordsPerBlock: 115 }, { numBlocks: 1, dataCodewordsPerBlock: 116 }] },
      { ecCodewordsPerBlock: 28, ecBlocks: [{ numBlocks: 14, dataCodewordsPerBlock: 46 }, { numBlocks: 21, dataCodewordsPerBlock: 47 }] },
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 29, dataCodewordsPerBlock: 24 }, { numBlocks: 19, dataCodewordsPerBlock: 25 }] },
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 11, dataCodewordsPerBlock: 15 }, { numBlocks: 46, dataCodewordsPerBlock: 16 }] },
    ] },
    { infoBits: 0x228ba, versionNumber: 34, alignmentPatternCenters: [6, 34, 62, 90, 118, 146], errorCorrectionLevels: [
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 13, dataCodewordsPerBlock: 115 }, { numBlocks: 6, dataCodewordsPerBlock: 116 }] },
      { ecCodewordsPerBlock: 28, ecBlocks: [{ numBlocks: 14, dataCodewordsPerBlock: 46 }, { numBlocks: 23, dataCodewordsPerBlock: 47 }] },
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 44, dataCodewordsPerBlock: 24 }, { numBlocks: 7, dataCodewordsPerBlock: 25 }] },
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 59, dataCodewordsPerBlock: 16 }, { numBlocks: 1, dataCodewordsPerBlock: 17 }] },
    ] },
    { infoBits: 0x2379f, versionNumber: 35, alignmentPatternCenters: [6, 30, 54, 78, 102, 126, 150], errorCorrectionLevels: [
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 12, dataCodewordsPerBlock: 121 }, { numBlocks: 7, dataCodewordsPerBlock: 122 }] },
      { ecCodewordsPerBlock: 28, ecBlocks: [{ numBlocks: 12, dataCodewordsPerBlock: 47 }, { numBlocks: 26, dataCodewordsPerBlock: 48 }] },
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 39, dataCodewordsPerBlock: 24 }, { numBlocks: 14, dataCodewordsPerBlock: 25 }] },
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 22, dataCodewordsPerBlock: 15 }, { numBlocks: 41, dataCodewordsPerBlock: 16 }] },
    ] },
    { infoBits: 0x24b0b, versionNumber: 36, alignmentPatternCenters: [6, 24, 50, 76, 102, 128, 154], errorCorrectionLevels: [
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 6, dataCodewordsPerBlock: 121 }, { numBlocks: 14, dataCodewordsPerBlock: 122 }] },
      { ecCodewordsPerBlock: 28, ecBlocks: [{ numBlocks: 6, dataCodewordsPerBlock: 47 }, { numBlocks: 34, dataCodewordsPerBlock: 48 }] },
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 46, dataCodewordsPerBlock: 24 }, { numBlocks: 10, dataCodewordsPerBlock: 25 }] },
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 2, dataCodewordsPerBlock: 15 }, { numBlocks: 64, dataCodewordsPerBlock: 16 }] },
    ] },
    { infoBits: 0x2542e, versionNumber: 37, alignmentPatternCenters: [6, 28, 54, 80, 106, 132, 158], errorCorrectionLevels: [
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 17, dataCodewordsPerBlock: 122 }, { numBlocks: 4, dataCodewordsPerBlock: 123 }] },
      { ecCodewordsPerBlock: 28, ecBlocks: [{ numBlocks: 29, dataCodewordsPerBlock: 46 }, { numBlocks: 14, dataCodewordsPerBlock: 47 }] },
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 49, dataCodewordsPerBlock: 24 }, { numBlocks: 10, dataCodewordsPerBlock: 25 }] },
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 24, dataCodewordsPerBlock: 15 }, { numBlocks: 46, dataCodewordsPerBlock: 16 }] },
    ] },
    { infoBits: 0x26a64, versionNumber: 38, alignmentPatternCenters: [6, 32, 58, 84, 110, 136, 162], errorCorrectionLevels: [
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 4, dataCodewordsPerBlock: 122 }, { numBlocks: 18, dataCodewordsPerBlock: 123 }] },
      { ecCodewordsPerBlock: 28, ecBlocks: [{ numBlocks: 13, dataCodewordsPerBlock: 46 }, { numBlocks: 32, dataCodewordsPerBlock: 47 }] },
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 48, dataCodewordsPerBlock: 24 }, { numBlocks: 14, dataCodewordsPerBlock: 25 }] },
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 42, dataCodewordsPerBlock: 15 }, { numBlocks: 32, dataCodewordsPerBlock: 16 }] },
    ] },
    { infoBits: 0x27541, versionNumber: 39, alignmentPatternCenters: [6, 26, 54, 82, 110, 138, 166], errorCorrectionLevels: [
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 20, dataCodewordsPerBlock: 117 }, { numBlocks: 4, dataCodewordsPerBlock: 118 }] },
      { ecCodewordsPerBlock: 28, ecBlocks: [{ numBlocks: 40, dataCodewordsPerBlock: 47 }, { numBlocks: 7, dataCodewordsPerBlock: 48 }] },
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 43, dataCodewordsPerBlock: 24 }, { numBlocks: 22, dataCodewordsPerBlock: 25 }] },
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 10, dataCodewordsPerBlock: 15 }, { numBlocks: 67, dataCodewordsPerBlock: 16 }] },
    ] },
    { infoBits: 0x28c69, versionNumber: 40, alignmentPatternCenters: [6, 30, 58, 86, 114, 142, 170], errorCorrectionLevels: [
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 19, dataCodewordsPerBlock: 118 }, { numBlocks: 6, dataCodewordsPerBlock: 119 }] },
      { ecCodewordsPerBlock: 28, ecBlocks: [{ numBlocks: 18, dataCodewordsPerBlock: 47 }, { numBlocks: 31, dataCodewordsPerBlock: 48 }] },
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 34, dataCodewordsPerBlock: 24 }, { numBlocks: 34, dataCodewordsPerBlock: 25 }] },
      { ecCodewordsPerBlock: 30, ecBlocks: [{ numBlocks: 20, dataCodewordsPerBlock: 15 }, { numBlocks: 61, dataCodewordsPerBlock: 16 }] },
    ] },
  ];

  // =========================================================================
  // Decoder (format info, version info, codeword extraction, RS correction)
  // =========================================================================
  function numBitsDiffering(x, y) {
    let z = x ^ y; // eslint-disable-line no-bitwise
    let bitCount = 0;
    while (z) {
      bitCount++;
      z &= z - 1; // eslint-disable-line no-bitwise
    }
    return bitCount;
  }

  function pushBit(bit, byte) {
    return (byte << 1) | bit; // eslint-disable-line no-bitwise
  }

  const FORMAT_INFO_TABLE = [
    { bits: 0x5412, formatInfo: { errorCorrectionLevel: 1, dataMask: 0 } },
    { bits: 0x5125, formatInfo: { errorCorrectionLevel: 1, dataMask: 1 } },
    { bits: 0x5e7c, formatInfo: { errorCorrectionLevel: 1, dataMask: 2 } },
    { bits: 0x5b4b, formatInfo: { errorCorrectionLevel: 1, dataMask: 3 } },
    { bits: 0x45f9, formatInfo: { errorCorrectionLevel: 1, dataMask: 4 } },
    { bits: 0x40ce, formatInfo: { errorCorrectionLevel: 1, dataMask: 5 } },
    { bits: 0x4f97, formatInfo: { errorCorrectionLevel: 1, dataMask: 6 } },
    { bits: 0x4aa0, formatInfo: { errorCorrectionLevel: 1, dataMask: 7 } },
    { bits: 0x77c4, formatInfo: { errorCorrectionLevel: 0, dataMask: 0 } },
    { bits: 0x72f3, formatInfo: { errorCorrectionLevel: 0, dataMask: 1 } },
    { bits: 0x7daa, formatInfo: { errorCorrectionLevel: 0, dataMask: 2 } },
    { bits: 0x789d, formatInfo: { errorCorrectionLevel: 0, dataMask: 3 } },
    { bits: 0x662f, formatInfo: { errorCorrectionLevel: 0, dataMask: 4 } },
    { bits: 0x6318, formatInfo: { errorCorrectionLevel: 0, dataMask: 5 } },
    { bits: 0x6c41, formatInfo: { errorCorrectionLevel: 0, dataMask: 6 } },
    { bits: 0x6976, formatInfo: { errorCorrectionLevel: 0, dataMask: 7 } },
    { bits: 0x1689, formatInfo: { errorCorrectionLevel: 3, dataMask: 0 } },
    { bits: 0x13be, formatInfo: { errorCorrectionLevel: 3, dataMask: 1 } },
    { bits: 0x1ce7, formatInfo: { errorCorrectionLevel: 3, dataMask: 2 } },
    { bits: 0x19d0, formatInfo: { errorCorrectionLevel: 3, dataMask: 3 } },
    { bits: 0x0762, formatInfo: { errorCorrectionLevel: 3, dataMask: 4 } },
    { bits: 0x0255, formatInfo: { errorCorrectionLevel: 3, dataMask: 5 } },
    { bits: 0x0d0c, formatInfo: { errorCorrectionLevel: 3, dataMask: 6 } },
    { bits: 0x083b, formatInfo: { errorCorrectionLevel: 3, dataMask: 7 } },
    { bits: 0x355f, formatInfo: { errorCorrectionLevel: 2, dataMask: 0 } },
    { bits: 0x3068, formatInfo: { errorCorrectionLevel: 2, dataMask: 1 } },
    { bits: 0x3f31, formatInfo: { errorCorrectionLevel: 2, dataMask: 2 } },
    { bits: 0x3a06, formatInfo: { errorCorrectionLevel: 2, dataMask: 3 } },
    { bits: 0x24b4, formatInfo: { errorCorrectionLevel: 2, dataMask: 4 } },
    { bits: 0x2183, formatInfo: { errorCorrectionLevel: 2, dataMask: 5 } },
    { bits: 0x2eda, formatInfo: { errorCorrectionLevel: 2, dataMask: 6 } },
    { bits: 0x2bed, formatInfo: { errorCorrectionLevel: 2, dataMask: 7 } },
  ];

  const DATA_MASKS = [
    (p) => (p.y + p.x) % 2 === 0,
    (p) => p.y % 2 === 0,
    (p) => p.x % 3 === 0,
    (p) => (p.y + p.x) % 3 === 0,
    (p) => (Math.floor(p.y / 2) + Math.floor(p.x / 3)) % 2 === 0,
    (p) => ((p.x * p.y) % 2) + ((p.x * p.y) % 3) === 0,
    (p) => ((((p.y * p.x) % 2) + ((p.y * p.x) % 3)) % 2) === 0,
    (p) => ((((p.y + p.x) % 2) + ((p.y * p.x) % 3)) % 2) === 0,
  ];

  function buildFunctionPatternMask(version) {
    const dimension = 17 + 4 * version.versionNumber;
    const matrix = BitMatrix.createEmpty(dimension, dimension);

    matrix.setRegion(0, 0, 9, 9, true);
    matrix.setRegion(dimension - 8, 0, 8, 9, true);
    matrix.setRegion(0, dimension - 8, 9, 8, true);

    for (const x of version.alignmentPatternCenters) {
      for (const y of version.alignmentPatternCenters) {
        if (!((x === 6 && y === 6) || (x === 6 && y === dimension - 7) || (x === dimension - 7 && y === 6))) {
          matrix.setRegion(x - 2, y - 2, 5, 5, true);
        }
      }
    }

    matrix.setRegion(6, 9, 1, dimension - 17, true);
    matrix.setRegion(9, 6, dimension - 17, 1, true);

    if (version.versionNumber > 6) {
      matrix.setRegion(dimension - 11, 0, 3, 6, true);
      matrix.setRegion(0, dimension - 11, 6, 3, true);
    }

    return matrix;
  }

  function readCodewords(matrix, version, formatInfo) {
    const dataMask = DATA_MASKS[formatInfo.dataMask];
    const dimension = matrix.height;

    const functionPatternMask = buildFunctionPatternMask(version);

    const codewords = [];
    let currentByte = 0;
    let bitsRead = 0;

    let readingUp = true;
    for (let columnIndex = dimension - 1; columnIndex > 0; columnIndex -= 2) {
      if (columnIndex === 6) {
        columnIndex--;
      }
      for (let i = 0; i < dimension; i++) {
        const y = readingUp ? dimension - 1 - i : i;
        for (let columnOffset = 0; columnOffset < 2; columnOffset++) {
          const x = columnIndex - columnOffset;
          if (!functionPatternMask.get(x, y)) {
            bitsRead++;
            let bit = matrix.get(x, y);
            if (dataMask({ y, x })) {
              bit = !bit;
            }
            currentByte = pushBit(bit, currentByte);
            if (bitsRead === 8) {
              codewords.push(currentByte);
              bitsRead = 0;
              currentByte = 0;
            }
          }
        }
      }
      readingUp = !readingUp;
    }
    return codewords;
  }

  function readVersion(matrix) {
    const dimension = matrix.height;

    const provisionalVersion = Math.floor((dimension - 17) / 4);
    if (provisionalVersion <= 6) {
      return VERSIONS[provisionalVersion - 1];
    }

    let topRightVersionBits = 0;
    for (let y = 5; y >= 0; y--) {
      for (let x = dimension - 9; x >= dimension - 11; x--) {
        topRightVersionBits = pushBit(matrix.get(x, y), topRightVersionBits);
      }
    }

    let bottomLeftVersionBits = 0;
    for (let x = 5; x >= 0; x--) {
      for (let y = dimension - 9; y >= dimension - 11; y--) {
        bottomLeftVersionBits = pushBit(matrix.get(x, y), bottomLeftVersionBits);
      }
    }

    let bestDifference = Infinity;
    let bestVersion;
    for (const version of VERSIONS) {
      if (version.infoBits === topRightVersionBits || version.infoBits === bottomLeftVersionBits) {
        return version;
      }

      let difference = numBitsDiffering(topRightVersionBits, version.infoBits);
      if (difference < bestDifference) {
        bestVersion = version;
        bestDifference = difference;
      }

      difference = numBitsDiffering(bottomLeftVersionBits, version.infoBits);
      if (difference < bestDifference) {
        bestVersion = version;
        bestDifference = difference;
      }
    }
    if (bestDifference <= 3) {
      return bestVersion;
    }
    return null;
  }

  function readFormatInformation(matrix) {
    let topLeftFormatInfoBits = 0;
    for (let x = 0; x <= 8; x++) {
      if (x !== 6) {
        topLeftFormatInfoBits = pushBit(matrix.get(x, 8), topLeftFormatInfoBits);
      }
    }
    for (let y = 7; y >= 0; y--) {
      if (y !== 6) {
        topLeftFormatInfoBits = pushBit(matrix.get(8, y), topLeftFormatInfoBits);
      }
    }

    const dimension = matrix.height;
    let topRightBottomRightFormatInfoBits = 0;
    for (let y = dimension - 1; y >= dimension - 7; y--) {
      topRightBottomRightFormatInfoBits = pushBit(matrix.get(8, y), topRightBottomRightFormatInfoBits);
    }
    for (let x = dimension - 8; x < dimension; x++) {
      topRightBottomRightFormatInfoBits = pushBit(matrix.get(x, 8), topRightBottomRightFormatInfoBits);
    }

    let bestDifference = Infinity;
    let bestFormatInfo = null;
    for (const entry of FORMAT_INFO_TABLE) {
      const bits = entry.bits;
      const formatInfo = entry.formatInfo;
      if (bits === topLeftFormatInfoBits || bits === topRightBottomRightFormatInfoBits) {
        return formatInfo;
      }
      let difference = numBitsDiffering(topLeftFormatInfoBits, bits);
      if (difference < bestDifference) {
        bestFormatInfo = formatInfo;
        bestDifference = difference;
      }
      if (topLeftFormatInfoBits !== topRightBottomRightFormatInfoBits) {
        difference = numBitsDiffering(topRightBottomRightFormatInfoBits, bits);
        if (difference < bestDifference) {
          bestFormatInfo = formatInfo;
          bestDifference = difference;
        }
      }
    }
    if (bestDifference <= 3) {
      return bestFormatInfo;
    }
    return null;
  }

  function getDataBlocks(codewords, version, ecLevel) {
    const ecInfo = version.errorCorrectionLevels[ecLevel];
    const dataBlocks = [];

    let totalCodewords = 0;
    ecInfo.ecBlocks.forEach((block) => {
      for (let i = 0; i < block.numBlocks; i++) {
        dataBlocks.push({ numDataCodewords: block.dataCodewordsPerBlock, codewords: [] });
        totalCodewords += block.dataCodewordsPerBlock + ecInfo.ecCodewordsPerBlock;
      }
    });

    if (codewords.length < totalCodewords) {
      return null;
    }
    codewords = codewords.slice(0, totalCodewords);

    const shortBlockSize = ecInfo.ecBlocks[0].dataCodewordsPerBlock;
    for (let i = 0; i < shortBlockSize; i++) {
      for (const dataBlock of dataBlocks) {
        dataBlock.codewords.push(codewords.shift());
      }
    }

    if (ecInfo.ecBlocks.length > 1) {
      const smallBlockCount = ecInfo.ecBlocks[0].numBlocks;
      const largeBlockCount = ecInfo.ecBlocks[1].numBlocks;
      for (let i = 0; i < largeBlockCount; i++) {
        dataBlocks[smallBlockCount + i].codewords.push(codewords.shift());
      }
    }

    while (codewords.length > 0) {
      for (const dataBlock of dataBlocks) {
        dataBlock.codewords.push(codewords.shift());
      }
    }

    return dataBlocks;
  }

  function decodeMatrix(matrix) {
    const version = readVersion(matrix);
    if (!version) {
      return null;
    }

    const formatInfo = readFormatInformation(matrix);
    if (!formatInfo) {
      return null;
    }

    const codewords = readCodewords(matrix, version, formatInfo);
    const dataBlocks = getDataBlocks(codewords, version, formatInfo.errorCorrectionLevel);
    if (!dataBlocks) {
      return null;
    }

    const totalBytes = dataBlocks.reduce((a, b) => a + b.numDataCodewords, 0);
    const resultBytes = new Uint8ClampedArray(totalBytes);

    let resultIndex = 0;
    for (const dataBlock of dataBlocks) {
      const correctedBytes = rsDecode(dataBlock.codewords, dataBlock.codewords.length - dataBlock.numDataCodewords);
      if (!correctedBytes) {
        return null;
      }
      for (let i = 0; i < dataBlock.numDataCodewords; i++) {
        resultBytes[resultIndex++] = correctedBytes[i];
      }
    }

    try {
      return decodeSegments(resultBytes, version.versionNumber);
    } catch (e) {
      return null;
    }
  }

  function decodeQRMatrix(matrix) {
    if (matrix == null) {
      return null;
    }
    const result = decodeMatrix(matrix);
    if (result) {
      return result;
    }
    // Decoding didn't work, try mirroring the QR across the topLeft -> bottomRight line.
    for (let x = 0; x < matrix.width; x++) {
      for (let y = x + 1; y < matrix.height; y++) {
        if (matrix.get(x, y) !== matrix.get(y, x)) {
          matrix.set(x, y, !matrix.get(x, y));
          matrix.set(y, x, !matrix.get(y, x));
        }
      }
    }
    return decodeMatrix(matrix);
  }

  // =========================================================================
  // Extractor (perspective transform to sample the module grid)
  // =========================================================================
  function squareToQuadrilateral(p1, p2, p3, p4) {
    const dx3 = p1.x - p2.x + p3.x - p4.x;
    const dy3 = p1.y - p2.y + p3.y - p4.y;
    if (dx3 === 0 && dy3 === 0) {
      return {
        a11: p2.x - p1.x,
        a12: p2.y - p1.y,
        a13: 0,
        a21: p3.x - p2.x,
        a22: p3.y - p2.y,
        a23: 0,
        a31: p1.x,
        a32: p1.y,
        a33: 1,
      };
    } else {
      const dx1 = p2.x - p3.x;
      const dx2 = p4.x - p3.x;
      const dy1 = p2.y - p3.y;
      const dy2 = p4.y - p3.y;
      const denominator = dx1 * dy2 - dx2 * dy1;
      const a13 = (dx3 * dy2 - dx2 * dy3) / denominator;
      const a23 = (dx1 * dy3 - dx3 * dy1) / denominator;
      return {
        a11: p2.x - p1.x + a13 * p2.x,
        a12: p2.y - p1.y + a13 * p2.y,
        a13,
        a21: p4.x - p1.x + a23 * p4.x,
        a22: p4.y - p1.y + a23 * p4.y,
        a23,
        a31: p1.x,
        a32: p1.y,
        a33: 1,
      };
    }
  }

  function quadrilateralToSquare(p1, p2, p3, p4) {
    const sToQ = squareToQuadrilateral(p1, p2, p3, p4);
    return {
      a11: sToQ.a22 * sToQ.a33 - sToQ.a23 * sToQ.a32,
      a12: sToQ.a13 * sToQ.a32 - sToQ.a12 * sToQ.a33,
      a13: sToQ.a12 * sToQ.a23 - sToQ.a13 * sToQ.a22,
      a21: sToQ.a23 * sToQ.a31 - sToQ.a21 * sToQ.a33,
      a22: sToQ.a11 * sToQ.a33 - sToQ.a13 * sToQ.a31,
      a23: sToQ.a13 * sToQ.a21 - sToQ.a11 * sToQ.a23,
      a31: sToQ.a21 * sToQ.a32 - sToQ.a22 * sToQ.a31,
      a32: sToQ.a12 * sToQ.a31 - sToQ.a11 * sToQ.a32,
      a33: sToQ.a11 * sToQ.a22 - sToQ.a12 * sToQ.a21,
    };
  }

  function timesPerspective(a, b) {
    return {
      a11: a.a11 * b.a11 + a.a21 * b.a12 + a.a31 * b.a13,
      a12: a.a12 * b.a11 + a.a22 * b.a12 + a.a32 * b.a13,
      a13: a.a13 * b.a11 + a.a23 * b.a12 + a.a33 * b.a13,
      a21: a.a11 * b.a21 + a.a21 * b.a22 + a.a31 * b.a23,
      a22: a.a12 * b.a21 + a.a22 * b.a22 + a.a32 * b.a23,
      a23: a.a13 * b.a21 + a.a23 * b.a22 + a.a33 * b.a23,
      a31: a.a11 * b.a31 + a.a21 * b.a32 + a.a31 * b.a33,
      a32: a.a12 * b.a31 + a.a22 * b.a32 + a.a32 * b.a33,
      a33: a.a13 * b.a31 + a.a23 * b.a32 + a.a33 * b.a33,
    };
  }

  function extract(image, location) {
    const qToS = quadrilateralToSquare(
      { x: 3.5, y: 3.5 },
      { x: location.dimension - 3.5, y: 3.5 },
      { x: location.dimension - 6.5, y: location.dimension - 6.5 },
      { x: 3.5, y: location.dimension - 3.5 }
    );
    const sToQ = squareToQuadrilateral(location.topLeft, location.topRight, location.alignmentPattern, location.bottomLeft);
    const transform = timesPerspective(sToQ, qToS);

    const matrix = BitMatrix.createEmpty(location.dimension, location.dimension);
    const mappingFunction = (x, y) => {
      const denominator = transform.a13 * x + transform.a23 * y + transform.a33;
      return {
        x: (transform.a11 * x + transform.a21 * y + transform.a31) / denominator,
        y: (transform.a12 * x + transform.a22 * y + transform.a32) / denominator,
      };
    };

    for (let y = 0; y < location.dimension; y++) {
      for (let x = 0; x < location.dimension; x++) {
        const xValue = x + 0.5;
        const yValue = y + 0.5;
        const sourcePixel = mappingFunction(xValue, yValue);
        matrix.set(x, y, image.get(Math.floor(sourcePixel.x), Math.floor(sourcePixel.y)));
      }
    }

    return { matrix, mappingFunction };
  }

  // =========================================================================
  // Locator (finder pattern + alignment pattern search)
  // =========================================================================
  const MAX_FINDERPATTERNS_TO_SEARCH = 4;
  const MIN_QUAD_RATIO = 0.5;
  const MAX_QUAD_RATIO = 1.5;

  const distance = (a, b) => Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);

  function sum(values) {
    return values.reduce((a, b) => a + b);
  }

  function reorderFinderPatterns(pattern1, pattern2, pattern3) {
    const oneTwoDistance = distance(pattern1, pattern2);
    const twoThreeDistance = distance(pattern2, pattern3);
    const oneThreeDistance = distance(pattern1, pattern3);

    let bottomLeft;
    let topLeft;
    let topRight;

    if (twoThreeDistance >= oneTwoDistance && twoThreeDistance >= oneThreeDistance) {
      bottomLeft = pattern2;
      topLeft = pattern1;
      topRight = pattern3;
    } else if (oneThreeDistance >= twoThreeDistance && oneThreeDistance >= oneTwoDistance) {
      bottomLeft = pattern1;
      topLeft = pattern2;
      topRight = pattern3;
    } else {
      bottomLeft = pattern1;
      topLeft = pattern3;
      topRight = pattern2;
    }

    if ((topRight.x - topLeft.x) * (bottomLeft.y - topLeft.y) - (topRight.y - topLeft.y) * (bottomLeft.x - topLeft.x) < 0) {
      const tmp = bottomLeft;
      bottomLeft = topRight;
      topRight = tmp;
    }

    return { bottomLeft, topLeft, topRight };
  }

  function computeDimension(topLeft, topRight, bottomLeft, matrix) {
    const moduleSize =
      (sum(countBlackWhiteRun(topLeft, bottomLeft, matrix, 5)) / 7 +
        sum(countBlackWhiteRun(topLeft, topRight, matrix, 5)) / 7 +
        sum(countBlackWhiteRun(bottomLeft, topLeft, matrix, 5)) / 7 +
        sum(countBlackWhiteRun(topRight, topLeft, matrix, 5)) / 7) /
      4;

    if (moduleSize < 1) {
      throw new Error("Invalid module size");
    }

    const topDimension = Math.round(distance(topLeft, topRight) / moduleSize);
    const sideDimension = Math.round(distance(topLeft, bottomLeft) / moduleSize);
    let dimension = Math.floor((topDimension + sideDimension) / 2) + 7;
    switch (dimension % 4) {
      case 0:
        dimension++;
        break;
      case 2:
        dimension--;
        break;
    }
    return { dimension, moduleSize };
  }

  function countBlackWhiteRunTowardsPoint(origin, end, matrix, length) {
    const switchPoints = [{ x: Math.floor(origin.x), y: Math.floor(origin.y) }];
    const steep = Math.abs(end.y - origin.y) > Math.abs(end.x - origin.x);

    let fromX;
    let fromY;
    let toX;
    let toY;
    if (steep) {
      fromX = Math.floor(origin.y);
      fromY = Math.floor(origin.x);
      toX = Math.floor(end.y);
      toY = Math.floor(end.x);
    } else {
      fromX = Math.floor(origin.x);
      fromY = Math.floor(origin.y);
      toX = Math.floor(end.x);
      toY = Math.floor(end.y);
    }

    const dx = Math.abs(toX - fromX);
    const dy = Math.abs(toY - fromY);
    let error = Math.floor(-dx / 2);
    const xStep = fromX < toX ? 1 : -1;
    const yStep = fromY < toY ? 1 : -1;

    let currentPixel = true;
    for (let x = fromX, y = fromY; x !== toX + xStep; x += xStep) {
      const realX = steep ? y : x;
      const realY = steep ? x : y;
      if (matrix.get(realX, realY) !== currentPixel) {
        currentPixel = !currentPixel;
        switchPoints.push({ x: realX, y: realY });
        if (switchPoints.length === length + 1) {
          break;
        }
      }
      error += dy;
      if (error > 0) {
        if (y === toY) {
          break;
        }
        y += yStep;
        error -= dx;
      }
    }
    const distances = [];
    for (let i = 0; i < length; i++) {
      if (switchPoints[i] && switchPoints[i + 1]) {
        distances.push(distance(switchPoints[i], switchPoints[i + 1]));
      } else {
        distances.push(0);
      }
    }
    return distances;
  }

  function countBlackWhiteRun(origin, end, matrix, length) {
    const rise = end.y - origin.y;
    const run = end.x - origin.x;

    const towardsEnd = countBlackWhiteRunTowardsPoint(origin, end, matrix, Math.ceil(length / 2));
    const awayFromEnd = countBlackWhiteRunTowardsPoint(
      origin,
      { x: origin.x - run, y: origin.y - rise },
      matrix,
      Math.ceil(length / 2)
    );

    const middleValue = towardsEnd.shift() + awayFromEnd.shift() - 1;
    return awayFromEnd.concat(middleValue).concat(towardsEnd);
  }

  function scoreBlackWhiteRun(sequence, ratios) {
    const averageSize = sum(sequence) / sum(ratios);
    let error = 0;
    ratios.forEach((ratio, i) => {
      error += (sequence[i] - ratio * averageSize) ** 2;
    });

    return { averageSize, error };
  }

  function scorePattern(point, ratios, matrix) {
    try {
      const horizontalRun = countBlackWhiteRun(point, { x: -1, y: point.y }, matrix, ratios.length);
      const verticalRun = countBlackWhiteRun(point, { x: point.x, y: -1 }, matrix, ratios.length);

      const topLeftPoint = {
        x: Math.max(0, point.x - point.y) - 1,
        y: Math.max(0, point.y - point.x) - 1,
      };
      const topLeftBottomRightRun = countBlackWhiteRun(point, topLeftPoint, matrix, ratios.length);

      const bottomLeftPoint = {
        x: Math.min(matrix.width, point.x + point.y) + 1,
        y: Math.min(matrix.height, point.y + point.x) + 1,
      };
      const bottomLeftTopRightRun = countBlackWhiteRun(point, bottomLeftPoint, matrix, ratios.length);

      const horzError = scoreBlackWhiteRun(horizontalRun, ratios);
      const vertError = scoreBlackWhiteRun(verticalRun, ratios);
      const diagDownError = scoreBlackWhiteRun(topLeftBottomRightRun, ratios);
      const diagUpError = scoreBlackWhiteRun(bottomLeftTopRightRun, ratios);

      const ratioError = Math.sqrt(
        horzError.error * horzError.error +
          vertError.error * vertError.error +
          diagDownError.error * diagDownError.error +
          diagUpError.error * diagUpError.error
      );

      const avgSize = (horzError.averageSize + vertError.averageSize + diagDownError.averageSize + diagUpError.averageSize) / 4;

      const sizeError =
        ((horzError.averageSize - avgSize) ** 2 +
          (vertError.averageSize - avgSize) ** 2 +
          (diagDownError.averageSize - avgSize) ** 2 +
          (diagUpError.averageSize - avgSize) ** 2) /
        avgSize;
      return ratioError + sizeError;
    } catch (e) {
      return Infinity;
    }
  }

  function recenterLocation(matrix, p) {
    let leftX = Math.round(p.x);
    while (matrix.get(leftX, Math.round(p.y))) {
      leftX--;
    }
    let rightX = Math.round(p.x);
    while (matrix.get(rightX, Math.round(p.y))) {
      rightX++;
    }
    const x = (leftX + rightX) / 2;

    let topY = Math.round(p.y);
    while (matrix.get(Math.round(x), topY)) {
      topY--;
    }
    let bottomY = Math.round(p.y);
    while (matrix.get(Math.round(x), bottomY)) {
      bottomY++;
    }
    const y = (topY + bottomY) / 2;

    return { x, y };
  }

  function locate(matrix) {
    const finderPatternQuads = [];
    let activeFinderPatternQuads = [];
    const alignmentPatternQuads = [];
    let activeAlignmentPatternQuads = [];

    for (let y = 0; y <= matrix.height; y++) {
      let length = 0;
      let lastBit = false;
      let scans = [0, 0, 0, 0, 0];

      for (let x = -1; x <= matrix.width; x++) {
        const v = matrix.get(x, y);
        if (v === lastBit) {
          length++;
        } else {
          scans = [scans[1], scans[2], scans[3], scans[4], length];
          length = 1;
          lastBit = v;

          const averageFinderPatternBlocksize = sum(scans) / 7;
          const validFinderPattern =
            Math.abs(scans[0] - averageFinderPatternBlocksize) < averageFinderPatternBlocksize &&
            Math.abs(scans[1] - averageFinderPatternBlocksize) < averageFinderPatternBlocksize &&
            Math.abs(scans[2] - 3 * averageFinderPatternBlocksize) < 3 * averageFinderPatternBlocksize &&
            Math.abs(scans[3] - averageFinderPatternBlocksize) < averageFinderPatternBlocksize &&
            Math.abs(scans[4] - averageFinderPatternBlocksize) < averageFinderPatternBlocksize &&
            !v;

          const averageAlignmentPatternBlocksize = sum(scans.slice(-3)) / 3;
          const validAlignmentPattern =
            Math.abs(scans[2] - averageAlignmentPatternBlocksize) < averageAlignmentPatternBlocksize &&
            Math.abs(scans[3] - averageAlignmentPatternBlocksize) < averageAlignmentPatternBlocksize &&
            Math.abs(scans[4] - averageAlignmentPatternBlocksize) < averageAlignmentPatternBlocksize &&
            v;

          if (validFinderPattern) {
            const endX = x - scans[3] - scans[4];
            const startX = endX - scans[2];

            const line = { startX, endX, y };
            const matchingQuads = activeFinderPatternQuads.filter(
              (q) =>
                (startX >= q.bottom.startX && startX <= q.bottom.endX) ||
                (endX >= q.bottom.startX && startX <= q.bottom.endX) ||
                (startX <= q.bottom.startX &&
                  endX >= q.bottom.endX &&
                  scans[2] / (q.bottom.endX - q.bottom.startX) < MAX_QUAD_RATIO &&
                  scans[2] / (q.bottom.endX - q.bottom.startX) > MIN_QUAD_RATIO)
            );
            if (matchingQuads.length > 0) {
              matchingQuads[0].bottom = line;
            } else {
              activeFinderPatternQuads.push({ top: line, bottom: line });
            }
          }
          if (validAlignmentPattern) {
            const endX = x - scans[4];
            const startX = endX - scans[3];

            const line = { startX, y, endX };
            const matchingQuads = activeAlignmentPatternQuads.filter(
              (q) =>
                (startX >= q.bottom.startX && startX <= q.bottom.endX) ||
                (endX >= q.bottom.startX && startX <= q.bottom.endX) ||
                (startX <= q.bottom.startX &&
                  endX >= q.bottom.endX &&
                  scans[2] / (q.bottom.endX - q.bottom.startX) < MAX_QUAD_RATIO &&
                  scans[2] / (q.bottom.endX - q.bottom.startX) > MIN_QUAD_RATIO)
            );
            if (matchingQuads.length > 0) {
              matchingQuads[0].bottom = line;
            } else {
              activeAlignmentPatternQuads.push({ top: line, bottom: line });
            }
          }
        }
      }
      finderPatternQuads.push.apply(
        finderPatternQuads,
        activeFinderPatternQuads.filter((q) => q.bottom.y !== y && q.bottom.y - q.top.y >= 2)
      );
      activeFinderPatternQuads = activeFinderPatternQuads.filter((q) => q.bottom.y === y);

      alignmentPatternQuads.push.apply(
        alignmentPatternQuads,
        activeAlignmentPatternQuads.filter((q) => q.bottom.y !== y)
      );
      activeAlignmentPatternQuads = activeAlignmentPatternQuads.filter((q) => q.bottom.y === y);
    }

    finderPatternQuads.push.apply(
      finderPatternQuads,
      activeFinderPatternQuads.filter((q) => q.bottom.y - q.top.y >= 2)
    );
    alignmentPatternQuads.push.apply(alignmentPatternQuads, activeAlignmentPatternQuads);

    const finderPatternGroups = finderPatternQuads
      .filter((q) => q.bottom.y - q.top.y >= 2)
      .map((q) => {
        const x = (q.top.startX + q.top.endX + q.bottom.startX + q.bottom.endX) / 4;
        const y = (q.top.y + q.bottom.y + 1) / 2;
        if (!matrix.get(Math.round(x), Math.round(y))) {
          return null;
        }

        const lengths = [q.top.endX - q.top.startX, q.bottom.endX - q.bottom.startX, q.bottom.y - q.top.y + 1];
        const size = sum(lengths) / lengths.length;
        const score = scorePattern({ x: Math.round(x), y: Math.round(y) }, [1, 1, 3, 1, 1], matrix);
        return { score, x, y, size };
      })
      .filter((q) => !!q)
      .sort((a, b) => a.score - b.score)
      .map((point, i, finderPatterns) => {
        if (i > MAX_FINDERPATTERNS_TO_SEARCH) {
          return null;
        }
        const otherPoints = finderPatterns
          .filter((p, ii) => i !== ii)
          .map((p) => ({ x: p.x, y: p.y, score: p.score + (p.size - point.size) ** 2 / point.size, size: p.size }))
          .sort((a, b) => a.score - b.score);
        if (otherPoints.length < 2) {
          return null;
        }
        const score = point.score + otherPoints[0].score + otherPoints[1].score;
        return { points: [point].concat(otherPoints.slice(0, 2)), score };
      })
      .filter((q) => !!q)
      .sort((a, b) => a.score - b.score);

    if (finderPatternGroups.length === 0) {
      return null;
    }

    const reordered = reorderFinderPatterns(
      finderPatternGroups[0].points[0],
      finderPatternGroups[0].points[1],
      finderPatternGroups[0].points[2]
    );
    const topRight = reordered.topRight;
    const topLeft = reordered.topLeft;
    const bottomLeft = reordered.bottomLeft;

    const alignment = findAlignmentPattern(matrix, alignmentPatternQuads, topRight, topLeft, bottomLeft);
    const result = [];
    if (alignment) {
      result.push({
        alignmentPattern: { x: alignment.alignmentPattern.x, y: alignment.alignmentPattern.y },
        bottomLeft: { x: bottomLeft.x, y: bottomLeft.y },
        dimension: alignment.dimension,
        topLeft: { x: topLeft.x, y: topLeft.y },
        topRight: { x: topRight.x, y: topRight.y },
      });
    }

    const midTopRight = recenterLocation(matrix, topRight);
    const midTopLeft = recenterLocation(matrix, topLeft);
    const midBottomLeft = recenterLocation(matrix, bottomLeft);
    const centeredAlignment = findAlignmentPattern(matrix, alignmentPatternQuads, midTopRight, midTopLeft, midBottomLeft);
    if (centeredAlignment) {
      result.push({
        alignmentPattern: { x: centeredAlignment.alignmentPattern.x, y: centeredAlignment.alignmentPattern.y },
        bottomLeft: { x: midBottomLeft.x, y: midBottomLeft.y },
        topLeft: { x: midTopLeft.x, y: midTopLeft.y },
        topRight: { x: midTopRight.x, y: midTopRight.y },
        dimension: centeredAlignment.dimension,
      });
    }

    if (result.length === 0) {
      return null;
    }

    return result;
  }

  function findAlignmentPattern(matrix, alignmentPatternQuads, topRight, topLeft, bottomLeft) {
    let dimension;
    let moduleSize;
    try {
      const dims = computeDimension(topLeft, topRight, bottomLeft, matrix);
      dimension = dims.dimension;
      moduleSize = dims.moduleSize;
    } catch (e) {
      return null;
    }

    const bottomRightFinderPattern = {
      x: topRight.x - topLeft.x + bottomLeft.x,
      y: topRight.y - topLeft.y + bottomLeft.y,
    };
    const modulesBetweenFinderPatterns = (distance(topLeft, bottomLeft) + distance(topLeft, topRight)) / 2 / moduleSize;
    const correctionToTopLeft = 1 - 3 / modulesBetweenFinderPatterns;
    const expectedAlignmentPattern = {
      x: topLeft.x + correctionToTopLeft * (bottomRightFinderPattern.x - topLeft.x),
      y: topLeft.y + correctionToTopLeft * (bottomRightFinderPattern.y - topLeft.y),
    };

    const alignmentPatterns = alignmentPatternQuads
      .map((q) => {
        const x = (q.top.startX + q.top.endX + q.bottom.startX + q.bottom.endX) / 4;
        const y = (q.top.y + q.bottom.y + 1) / 2;
        if (!matrix.get(Math.floor(x), Math.floor(y))) {
          return null;
        }

        const sizeScore = scorePattern({ x: Math.floor(x), y: Math.floor(y) }, [1, 1, 1], matrix);
        const score = sizeScore + distance({ x, y }, expectedAlignmentPattern);
        return { x, y, score };
      })
      .filter((v) => !!v)
      .sort((a, b) => a.score - b.score);

    const alignmentPattern =
      modulesBetweenFinderPatterns >= 15 && alignmentPatterns.length ? alignmentPatterns[0] : expectedAlignmentPattern;

    return { alignmentPattern, dimension };
  }

  // =========================================================================
  // Top level entry point
  // =========================================================================
  function scan(matrix) {
    const locations = locate(matrix);
    if (!locations) {
      return null;
    }

    for (const location of locations) {
      const extracted = extract(matrix, location);
      const decoded = decodeQRMatrix(extracted.matrix);
      if (decoded) {
        return {
          binaryData: decoded.bytes,
          data: decoded.text,
          chunks: decoded.chunks,
          version: decoded.version,
          location: {
            topRightCorner: extracted.mappingFunction(location.dimension, 0),
            topLeftCorner: extracted.mappingFunction(0, 0),
            bottomRightCorner: extracted.mappingFunction(location.dimension, location.dimension),
            bottomLeftCorner: extracted.mappingFunction(0, location.dimension),

            topRightFinderPattern: location.topRight,
            topLeftFinderPattern: location.topLeft,
            bottomLeftFinderPattern: location.bottomLeft,

            bottomRightAlignmentPattern: location.alignmentPattern,
          },
        };
      }
    }
    return null;
  }

  const defaultOptions = {
    inversionAttempts: "attemptBoth",
  };

  function jsQR(data, width, height, providedOptions) {
    providedOptions = providedOptions || {};
    const options = {};
    Object.keys(defaultOptions).forEach((opt) => {
      options[opt] = providedOptions[opt] || defaultOptions[opt];
    });

    const shouldInvert = options.inversionAttempts === "attemptBoth" || options.inversionAttempts === "invertFirst";
    const tryInvertedFirst = options.inversionAttempts === "onlyInvert" || options.inversionAttempts === "invertFirst";
    const binarizeResult = binarize(data, width, height, shouldInvert);
    const binarized = binarizeResult.binarized;
    const inverted = binarizeResult.inverted;
    let result = scan(tryInvertedFirst ? inverted : binarized);
    if (!result && (options.inversionAttempts === "attemptBoth" || options.inversionAttempts === "invertFirst")) {
      result = scan(tryInvertedFirst ? binarized : inverted);
    }
    return result;
  }

  jsQR.default = jsQR;

  global.jsQR = jsQR;
})(typeof window !== "undefined" ? window : this);
