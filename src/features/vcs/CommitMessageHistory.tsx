import { useRef, useState, type RefObject } from "react";
import { IconButton, Menu } from "@/ui";

export function CommitMessageHistory({
  messages,
  onSelect,
  anchor,
  openTick,
  disabled = false,
}: {
  messages: readonly string[];
  onSelect: (message: string) => void;
  anchor?: RefObject<HTMLElement | null>;
  openTick?: number;
  disabled?: boolean;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [seenTick, setSeenTick] = useState(openTick);
  const available = !disabled && messages.length > 0;
  // The Git history action asks the same menu to open from the keyboard.
  if (openTick !== seenTick) {
    setSeenTick(openTick);
    if (available) setOpen(true);
  }
  if (!available && open) setOpen(false);
  return (
    <>
      <IconButton
        ref={button}
        icon="history"
        title="Commit Message History"
        size="small"
        disabled={!available}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      />
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchor ?? button}
        placement="top-start"
        iconColumn={false}
        aria-label="Recent commit messages"
        items={messages.map((message, i) => ({
          id: `h${i}`,
          label: message.split("\n")[0]!.slice(0, 80),
          run: () => onSelect(message),
        }))}
      />
    </>
  );
}
