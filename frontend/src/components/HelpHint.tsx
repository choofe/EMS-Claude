import { useEffect, useRef, useState, type ReactNode } from "react";
import { IconButton, Tooltip } from "@mui/material";
import HelpIcon from "@mui/icons-material/HelpOutline";

export const HOVER_DELAY_MS = 1000;
export const HOVER_STAY_MS = 5000;

/**
 * A small «؟» help. Desktop: opens after a 1-second hover pause and closes by itself after about 5 seconds.
 * Every device: a tap/click opens it and the next one closes it. Keyboard: focusing the button (Tab) opens it.
 */
export function HelpHint({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const wait = useRef<number | undefined>(undefined);
  const stay = useRef<number | undefined>(undefined);
  const clear = () => { window.clearTimeout(wait.current); window.clearTimeout(stay.current); };
  useEffect(() => clear, []);

  const hide = () => { clear(); setOpen(false); };
  const show = (autoClose: boolean) => {
    clear();
    setOpen(true);
    if (autoClose) stay.current = window.setTimeout(() => setOpen(false), HOVER_STAY_MS);
  };
  return (
    <Tooltip open={open} title={children} arrow placement="top" disableHoverListener disableFocusListener disableTouchListener>
      <IconButton size="small" aria-label={label} aria-expanded={open}
        onMouseEnter={() => { clear(); wait.current = window.setTimeout(() => show(true), HOVER_DELAY_MS); }}
        onMouseLeave={hide}
        onFocus={() => show(false)} onBlur={hide}
        onClick={() => (open ? hide() : show(false))}>
        <HelpIcon fontSize="small" />
      </IconButton>
    </Tooltip>
  );
}
