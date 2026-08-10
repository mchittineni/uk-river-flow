/**
 * Minimal element builders.
 *
 * The whole UI is constructed through these rather than by assigning `innerHTML`.
 * Station and river names come from third-party open data, so they are untrusted
 * strings; routing every one of them through `textContent` makes an escaping
 * mistake structurally impossible rather than something a reviewer has to catch.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Create an element.
 *
 * @param {string} tag Tag name, optionally with a `.class.list` suffix.
 * @param {object} [attributes] Attributes; `text` sets textContent, `dataset`
 *   sets data-* keys, `on` maps event names to listeners, `style` maps CSS
 *   custom properties and declarations.
 * @param {(Node|string|null|false)[]} [children] Strings become text nodes.
 */
export function h(tag, attributes = {}, children = []) {
  const [name, ...classes] = tag.split(".");
  const element = document.createElement(name);
  if (classes.length) element.classList.add(...classes);
  return apply(element, attributes, children);
}

/** Same as `h`, in the SVG namespace. HTML `createElement` cannot make SVG. */
export function s(tag, attributes = {}, children = []) {
  const [name, ...classes] = tag.split(".");
  const element = document.createElementNS(SVG_NS, name);
  if (classes.length) element.setAttribute("class", classes.join(" "));
  return apply(element, attributes, children);
}

function apply(element, attributes, children) {
  for (const [key, value] of Object.entries(attributes)) {
    if (value === null || value === undefined || value === false) continue;

    if (key === "text") {
      element.textContent = String(value);
    } else if (key === "dataset") {
      for (const [dataKey, dataValue] of Object.entries(value)) {
        element.dataset[dataKey] = String(dataValue);
      }
    } else if (key === "on") {
      for (const [event, listener] of Object.entries(value)) {
        element.addEventListener(event, listener);
      }
    } else if (key === "style" && typeof value === "object") {
      for (const [property, cssValue] of Object.entries(value)) {
        element.style.setProperty(property, String(cssValue));
      }
    } else {
      element.setAttribute(key, value === true ? "" : String(value));
    }
  }

  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    element.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return element;
}

/** Replace an element's children in one operation. */
export function replaceChildren(container, ...children) {
  container.replaceChildren(...children.flat().filter(Boolean));
  return container;
}

/** A `<dt>`/`<dd>` pair for the facts list. */
export function definition(label, value) {
  return [h("dt", { text: label }), h("dd", { text: value })];
}
