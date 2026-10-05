import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

const WIDTH = 280;
const MARGIN = 8;

/**
 * A small ⓘ button that shows an explanation in a popover, so the help is there when wanted
 * without crowding the screen. Tapping works on phones, where title tooltips don't; tapping
 * elsewhere, scrolling or Escape closes it.
 */
export function Info({ children, label = "More info" }: { children: ReactNode; label?: string }) {
  const button = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; width: number }>();

  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const r = button.current.getBoundingClientRect();
    const width = Math.min(WIDTH, window.innerWidth - 2 * MARGIN);
    const left = Math.min(Math.max(MARGIN, r.left + r.width / 2 - width / 2), window.innerWidth - width - MARGIN);
    const height = popover.current?.offsetHeight ?? 0;
    // Below the button, or above it when there isn't room below.
    const below = r.bottom + 6;
    const top = below + height > window.innerHeight - MARGIN && r.top - 6 - height > MARGIN ? r.top - 6 - height : below;
    setPos({ left, top, width });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      const t = e.target as Node;
      if (e.type === "pointerdown" && (popover.current?.contains(t) || button.current?.contains(t))) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", close, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <>
      <button
        ref={button}
        type="button"
        className="info-btn"
        aria-label={label}
        aria-expanded={open}
        onClick={(e) => {
          // Inside a label or link, show the help rather than acting on it.
          e.preventDefault();
          e.stopPropagation();
          setPos(undefined);
          setOpen((o) => !o);
        }}
      >
        i
      </button>
      {open &&
        createPortal(
          <div
            ref={popover}
            role="tooltip"
            className="info-pop small"
            style={pos ? { left: pos.left, top: pos.top, width: pos.width } : { visibility: "hidden", width: WIDTH }}
            onClick={(e) => e.stopPropagation()}
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}
