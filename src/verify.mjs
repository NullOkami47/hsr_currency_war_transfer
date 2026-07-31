function isIgnored(path, ignorePaths) {
  return ignorePaths.some(
    (ignoredPath) =>
      path === ignoredPath ||
      path.startsWith(`${ignoredPath}.`) ||
      path.startsWith(`${ignoredPath}[`),
  );
}

export function diffPayloads(
  expected,
  actual,
  { ignorePaths = [] } = {},
) {
  const differences = [];

  function visit(expectedValue, actualValue, path) {
    if (isIgnored(path, ignorePaths) || Object.is(expectedValue, actualValue)) {
      return;
    }

    if (Array.isArray(expectedValue) && Array.isArray(actualValue)) {
      const length = Math.max(expectedValue.length, actualValue.length);
      for (let index = 0; index < length; index += 1) {
        visit(
          expectedValue[index],
          actualValue[index],
          `${path}[${index}]`,
        );
      }
      return;
    }

    if (
      expectedValue &&
      actualValue &&
      typeof expectedValue === "object" &&
      typeof actualValue === "object"
    ) {
      const keys = new Set([
        ...Object.keys(expectedValue),
        ...Object.keys(actualValue),
      ]);
      for (const key of [...keys].sort()) {
        visit(
          expectedValue[key],
          actualValue[key],
          `${path}.${key}`,
        );
      }
      return;
    }

    differences.push({
      path,
      expected: expectedValue,
      actual: actualValue,
    });
  }

  visit(expected, actual, "$");
  return differences;
}

export class TransferVerificationError extends Error {
  constructor(differences) {
    super(
      `Published strategy differs from the transfer payload at ` +
        `${differences.length} path(s)`,
    );
    this.name = "TransferVerificationError";
    this.differences = differences;
  }
}

export function verifyTransferPayload(expected, actual, options = {}) {
  const differences = diffPayloads(expected, actual, options);
  if (differences.length > 0) {
    throw new TransferVerificationError(differences);
  }
  return { ok: true, differences };
}
