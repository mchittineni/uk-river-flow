/**
 * Keyboard behaviour for the segmented controls.
 *
 * `role="radio"` is a promise to assistive technology, and the markup alone does
 * not keep it. WAI-ARIA requires a radiogroup to be a *single* tab stop whose
 * members are reached with the arrow keys; without that, a keyboard user tabs
 * through every option one by one and a screen-reader user is told there is a
 * radio group that does not behave like one. Announcing the role while ignoring
 * its interaction contract is worse than plain buttons would have been.
 *
 * The handler also stops these keys propagating. The app binds Space and the
 * arrows on `document` to drive the time scrubber, and those bindings would
 * otherwise swallow the very keys this group needs: Space would toggle playback
 * instead of choosing the focused option, and Right would step the date instead
 * of moving to the next layer.
 */

const RADIO = '[role="radio"]';

/**
 * Which radio the key moves to, or `null` if the key is not ours.
 *
 * Split out from the DOM wiring because the wrap-around arithmetic is the part
 * worth testing, and the rest is `addEventListener`.
 */
export function nextRadioIndex(key, current, count) {
  if (count === 0) return null;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return (current + 1) % count;
    case "ArrowLeft":
    case "ArrowUp":
      return (current + count - 1) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/**
 * Reflect the current selection: `aria-checked` for the announcement, and a
 * roving `tabindex` so Tab enters the group at the selected option and leaves.
 *
 * @param {Element} container The element carrying `role="radiogroup"`.
 * @param {(radio: Element) => boolean} isSelected Predicate for the chosen radio.
 */
export function setRadioGroupSelection(container, isSelected) {
  for (const radio of container.querySelectorAll(RADIO)) {
    const selected = isSelected(radio);
    radio.setAttribute("aria-checked", String(selected));
    radio.setAttribute("tabindex", selected ? "0" : "-1");
  }
}

/**
 * Wire click and keyboard selection.
 *
 * `onSelect` receives the chosen element. Arrow keys select as they move, which
 * is the radiogroup pattern rather than the tablist one: for a group this small
 * every option is one keypress away, so requiring a separate confirm step buys
 * nothing.
 *
 * @param {Element} container The element carrying `role="radiogroup"`.
 * @param {(radio: Element) => void} onSelect Called with the newly chosen radio.
 */
export function bindRadioGroup(container, onSelect) {
  for (const radio of container.querySelectorAll(RADIO)) {
    radio.addEventListener("click", () => onSelect(radio));
  }

  container.addEventListener("keydown", (event) => {
    const radios = [...container.querySelectorAll(RADIO)];
    const current = radios.indexOf(event.target);
    if (current === -1) return;

    if (event.key === " " || event.key === "Enter") {
      // Let the native button activation fire the click handler above, but keep
      // the document-level Space binding from also toggling playback.
      event.stopPropagation();
      return;
    }

    const next = nextRadioIndex(event.key, current, radios.length);
    if (next === null) return;

    event.preventDefault();
    event.stopPropagation();
    radios[next].focus();
    onSelect(radios[next]);
  });
}
