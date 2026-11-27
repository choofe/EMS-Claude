import { useState, type ReactNode } from "react";
import { Button, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, Typography } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import HelpIcon from "@mui/icons-material/HelpOutline";

/**
 * A small «؟» help. A click/tap opens a small dialog with the text in the normal font size; it closes with «بستن», «×»,
 * Esc or a click outside. No hover tooltip and no timer: the text stays until the reader closes it.
 */
export function HelpHint({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <IconButton size="small" aria-label={label} aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <HelpIcon fontSize="small" />
      </IconButton>
      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="xs" fullWidth aria-labelledby="help-hint-title">
        <DialogTitle id="help-hint-title" sx={{ pe: 6 }}>
          {label}
          <IconButton aria-label="×" onClick={() => setOpen(false)} size="small" sx={{ position: "absolute", insetInlineEnd: 8, top: 8 }}><CloseIcon fontSize="small" /></IconButton>
        </DialogTitle>
        <DialogContent><Typography component="div" variant="body1" sx={{ lineHeight: 2 }}>{children}</Typography></DialogContent>
        <DialogActions><Button onClick={() => setOpen(false)}>بستن</Button></DialogActions>
      </Dialog>
    </>
  );
}
