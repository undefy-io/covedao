"use client";

import { useT } from "@/i18n/LanguageProvider";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * A small "what does this mean?" marker beside a label.
 *
 * Hover alone is not enough: it does not exist on a phone, and it does not
 * exist for anyone navigating by keyboard. This opens on hover, on focus and
 * on click, which covers all three, and closes on Escape or on a click
 * elsewhere.
 *
 * The bubble is rendered into `document.body` rather than beside the marker.
 * An absolutely-positioned bubble is clipped by any scrolling ancestor, and
 * the first place one of these landed was a table header inside an
 * `overflow-x-auto` container — where it never appeared at all. A portal has
 * no ancestor to be clipped by.
 *
 * It is `role="tooltip"` and wired to the button with `aria-describedby`, so a
 * screen reader announces the explanation as part of the control rather than
 * as loose text floating in the page.
 */

const WIDTH = 260;
const GAP = 8; // between the marker and the bubble
const MARGIN = 12; // smallest distance from a window edge

interface Placement {
  left: number;
  top: number;
  width: number;
  /** Where the arrow sits along the bubble's width. */
  arrowLeft: number;
  /** Sits below the marker because there was no room above. */
  below: boolean;
}

export function InfoTip({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const t = useT();
  const [place, setPlace] = useState<Placement | null>(null);
  const id = useId();
  const wrap = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  /**
   * What kind of pointer last pressed this.
   *
   * A mouse fires `mouseenter` before `click`, so a click-to-toggle would close
   * the bubble the hover had just opened — the marker looked broken to anyone
   * who clicked it. On a mouse, hover alone governs; the click is there for a
   * tap or a pen, which have no hover at all.
   */
  const pointerType = useRef<string>("");

  const position = useCallback(() => {
    const anchor = wrap.current?.getBoundingClientRect();
    if (!anchor) return;

    const width = Math.min(WIDTH, window.innerWidth - MARGIN * 2);
    const height = bubble.current?.offsetHeight ?? 0;
    const centre = anchor.left + anchor.width / 2;

    // Centred on the marker, then pulled back inside the window.
    const left = Math.max(MARGIN, Math.min(centre - width / 2, window.innerWidth - MARGIN - width));

    // Above by default; below only when above would not fit and below would.
    const roomAbove = anchor.top - GAP - height >= MARGIN;
    const roomBelow = anchor.bottom + GAP + height <= window.innerHeight - MARGIN;
    const below = !roomAbove && roomBelow;
    const top = below ? anchor.bottom + GAP : anchor.top - GAP - height;

    setPlace({ left, top, width, arrowLeft: centre - left, below });
  }, []);

  // Measured after the bubble exists, so its height is real rather than assumed.
  useLayoutEffect(() => {
    if (!open) {
      setPlace(null);
      return;
    }
    position();
  }, [open, position]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onPointer = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    // The marker can sit inside a scrolling table, so follow it rather than
    // leaving the bubble stranded where it was opened.
    const reposition = () => position();
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, position]);

  return (
    <span ref={wrap} className="relative inline-flex align-middle">
      <button
        type="button"
        aria-label={t("tip.whatIs", { label })}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onPointerDown={(e) => {
          pointerType.current = e.pointerType;
        }}
        onClick={() => {
          if (pointerType.current !== "mouse") setOpen((v) => !v);
        }}
        // Hover is decided from the event's own pointerType rather than a
        // remembered one: a tap fires a synthetic mouseenter too, and reading
        // it here keeps a touch from opening and then immediately toggling
        // itself shut.
        onPointerEnter={(e) => {
          if (e.pointerType === "mouse") setOpen(true);
        }}
        onPointerLeave={(e) => {
          if (e.pointerType === "mouse") setOpen(false);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border border-rule-bright text-[9px] leading-none text-bone-dim transition-colors hover:border-signal hover:text-signal"
      >
        i
      </button>

      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={bubble}
              role="tooltip"
              id={id}
              // `pointer-events-none` keeps the bubble from stealing the hover
              // that is keeping it open. Hidden until measured, so it never
              // flashes in the corner on the first frame.
              style={{
                left: place?.left ?? 0,
                top: place?.top ?? 0,
                width: place?.width ?? WIDTH,
                visibility: place ? "visible" : "hidden",
              }}
              className="pointer-events-none fixed z-50 border border-rule-bright bg-ink px-3 py-2 text-left text-xs font-normal normal-case leading-relaxed tracking-normal text-bone-2 shadow-lg"
            >
              {children}
              {place ? (
                <span
                  aria-hidden="true"
                  style={{ left: place.arrowLeft - 6 }}
                  className={
                    place.below
                      ? "absolute bottom-full h-0 w-0 border-x-[6px] border-b-[6px] border-x-transparent border-b-rule-bright"
                      : "absolute top-full h-0 w-0 border-x-[6px] border-t-[6px] border-x-transparent border-t-rule-bright"
                  }
                />
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
