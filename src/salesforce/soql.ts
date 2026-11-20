/** Quote a value for a SOQL string literal. */
export const soqlString = (value: string): string => {
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "\\'")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r");
  return `'${escaped}'`;
};

/** `null` or a quoted namespace prefix. */
export const soqlNamespace = (namespace: string | undefined): string =>
  namespace === undefined || namespace.length === 0 ? "null" : soqlString(namespace);
