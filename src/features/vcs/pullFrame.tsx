import type { ReactNode } from "react";
import { Dialog } from "@/ui";
import styles from "./common.module.css";

export function PullFrame({
  title,
  disabled,
  run,
  onClose,
  children,
}: {
  title: string;
  disabled: boolean;
  run: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog
      open
      title={title}
      onClose={onClose}
      width={460}
      buttons={[
        { label: "Pull", role: "default", disabled, onClick: run },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.form}>{children}</div>
    </Dialog>
  );
}
