/**
 * Heatmap-style row stagger for the expanding filter chip row.
 *
 * When the chip container opens (wraps onto multiple rows), each chip is
 * tagged with its row and column via CSS custom properties so the stylesheet
 * can animate a wave that travels down the rows with a slight diagonal lean.
 */
export function chipStagger(node: HTMLElement, initialExpanded: boolean) {
  let isExpanded = initialExpanded;
  let playCount = 0;
  let lastPlayedKey = "";
  let frame = 0;
  let playRequested = false;

  const schedule = (play: boolean) => {
    if (play) playRequested = true;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      // update() calls cancel pending layout reflows, but a resize callback
      // already in flight must not clobber a later play request — so the
      // play flag latches until this frame consumes it.
      const play = playRequested;
      playRequested = false;

      const children = Array.from(node.children) as HTMLElement[];
      let row = -1;
      let col = 0;
      let previousTop = Number.NaN;
      for (const child of children) {
        const top = child.offsetTop;
        if (top !== previousTop) {
          row += 1;
          col = 0;
          previousTop = top;
        } else {
          col += 1;
        }
        child.style.setProperty("--stagger-row", String(row));
        child.style.setProperty("--stagger-col", String(col));
      }

      if (play) {
        if (isExpanded) playCount += 1;
        else playCount = 0;
        // playCount keeps the dedupe key fresh across repeated expansions
        // of identical content, so the wave restarts every time the row
        // opens (and also when chip data changes while already open).
        const key = isExpanded ? playCount + ":" + children.length + ":" + row + ":" + col : "";
        if (key !== lastPlayedKey) {
          lastPlayedKey = key;
          node.classList.remove("chips-stagger");
          // Force a reflow so the animation restarts.
          void node.offsetWidth;
          if (isExpanded) node.classList.add("chips-stagger");
        }
      } else if (!isExpanded) {
        node.classList.remove("chips-stagger");
        lastPlayedKey = "";
        playCount = 0;
      }
    });
  };

  schedule(true);

  let resizeObserver: ResizeObserver | null = null;
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => schedule(false));
    resizeObserver.observe(node);
  }

  return {
    update(nextExpanded: boolean) {
      isExpanded = nextExpanded;
      schedule(true);
    },
    destroy() {
      cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
    }
  };
}
