/**
 * Minimal XML reader and writer for Salesforce Metadata SOAP and component files.
 * Local names only: namespace prefixes are stripped. Not a general XML library.
 */

export interface XmlElement {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly XmlElement[];
  readonly text: string;
}

const decodeXml = (value: string): string =>
  value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");

export const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const localName = (qualified: string): string => {
  const colon = qualified.indexOf(":");
  return colon === -1 ? qualified : qualified.slice(colon + 1);
};

class XmlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XmlParseError";
  }
}

/**
 * Parse one XML document. Returns the root element.
 * Processing instructions, comments, and the declaration are skipped.
 */
export const parseXml = (source: string): XmlElement => {
  let index = 0;

  const skipWhitespace = (): void => {
    while (index < source.length && /\s/.test(source[index] ?? "")) {
      index += 1;
    }
  };

  const skipNoise = (): void => {
    for (;;) {
      skipWhitespace();
      if (source.startsWith("<?", index)) {
        const end = source.indexOf("?>", index);
        if (end < 0) {
          throw new XmlParseError("Unclosed XML declaration.");
        }
        index = end + 2;
        continue;
      }
      if (source.startsWith("<!--", index)) {
        const end = source.indexOf("-->", index);
        if (end < 0) {
          throw new XmlParseError("Unclosed XML comment.");
        }
        index = end + 3;
        continue;
      }
      if (source.startsWith("<!", index)) {
        const end = source.indexOf(">", index);
        if (end < 0) {
          throw new XmlParseError("Unclosed XML directive.");
        }
        index = end + 1;
        continue;
      }
      return;
    }
  };

  const readName = (): string => {
    const start = index;
    while (index < source.length && /[\w:.-]/.test(source[index] ?? "")) {
      index += 1;
    }
    if (start === index) {
      throw new XmlParseError("Expected an XML name.");
    }
    return localName(source.slice(start, index));
  };

  const readAttributes = (): Record<string, string> => {
    const attributes: Record<string, string> = {};
    for (;;) {
      skipWhitespace();
      const next = source[index];
      if (next === undefined || next === ">" || next === "/") {
        return attributes;
      }
      const name = readName();
      skipWhitespace();
      if (source[index] !== "=") {
        throw new XmlParseError(`Expected '=' after attribute ${name}.`);
      }
      index += 1;
      skipWhitespace();
      const quote = source[index];
      if (quote !== '"' && quote !== "'") {
        throw new XmlParseError(`Expected a quoted attribute value for ${name}.`);
      }
      index += 1;
      const start = index;
      const end = source.indexOf(quote, index);
      if (end < 0) {
        throw new XmlParseError(`Unclosed attribute value for ${name}.`);
      }
      attributes[name] = decodeXml(source.slice(start, end));
      index = end + 1;
    }
  };

  const readElement = (): XmlElement => {
    skipNoise();
    if (source[index] !== "<") {
      throw new XmlParseError("Expected an XML element.");
    }
    index += 1;
    const name = readName();
    const attributes = readAttributes();
    skipWhitespace();
    if (source.startsWith("/>", index)) {
      index += 2;
      return { name, attributes, children: [], text: "" };
    }
    if (source[index] !== ">") {
      throw new XmlParseError(`Expected '>' after <${name}>.`);
    }
    index += 1;
    const children: XmlElement[] = [];
    let text = "";
    while (index < source.length) {
      if (source.startsWith("</", index)) {
        index += 2;
        const closing = readName();
        if (closing !== name) {
          throw new XmlParseError(`Expected </${name}> but found </${closing}>.`);
        }
        skipWhitespace();
        if (source[index] !== ">") {
          throw new XmlParseError(`Expected '>' after </${name}>.`);
        }
        index += 1;
        return { name, attributes, children, text: decodeXml(text).trim() };
      }
      const startsElement =
        source.startsWith("<", index) &&
        !source.startsWith("</", index) &&
        !source.startsWith("<?", index) &&
        !source.startsWith("<!", index);
      if (startsElement) {
        children.push(readElement());
        continue;
      }
      if (source.startsWith("<!", index) || source.startsWith("<?", index)) {
        skipNoise();
        continue;
      }
      const next = source.indexOf("<", index);
      const slice = next < 0 ? source.slice(index) : source.slice(index, next);
      text += slice;
      index = next < 0 ? source.length : next;
    }
    throw new XmlParseError(`Unclosed <${name}>.`);
  };

  const root = readElement();
  skipNoise();
  return root;
};

export const childElements = (element: XmlElement, name: string): readonly XmlElement[] =>
  element.children.filter((child) => child.name === name);

export const firstChild = (element: XmlElement, name: string): XmlElement | undefined =>
  element.children.find((child) => child.name === name);

/** Depth-first search by local name. */
export const findElements = (element: XmlElement, name: string): XmlElement[] => {
  const found: XmlElement[] = [];
  const visit = (current: XmlElement): void => {
    if (current.name === name) {
      found.push(current);
    }
    for (const child of current.children) {
      visit(child);
    }
  };
  visit(element);
  return found;
};
