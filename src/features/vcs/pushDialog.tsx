/** Shared Git/Jujutsu Push screen: header, central commit rows and standard footer. */
import type { ComponentProps, ReactNode } from "react";
import type { Commit } from "@/bindings";
import { Dialog, List, Spinner } from "@/ui";
import { tx } from "@/platform/i18n";
import { formatTime } from "./model";
import styles from "./common.module.css";

export function PushDialogFrame({
  header,
  children,
  ...props
}: Omit<ComponentProps<typeof Dialog>, "children"> & { header: ReactNode; children?: ReactNode }) {
  return (
    <Dialog {...props} width={620} resizable="both">
      <div className={styles.section}>{header}</div>
      {children}
    </Dialog>
  );
}

type PushCommit = Pick<Commit, "id" | "shortId" | "summary" | "author" | "timeMs">;
export function PushCommitList({
  commits,
  error,
  emptyText = tx("No commits"),
  label = "Outgoing commits",
}: {
  commits: readonly PushCommit[] | null;
  error?: string | null;
  emptyText?: ReactNode;
  label?: string;
}) {
  return (
    <div className={styles.pushListWrap}>
      {error ? (
        <div className={styles.error} role="alert">
          {error}
        </div>
      ) : !commits ? (
        <div className={styles.empty}>
          <Spinner size={14} />
        </div>
      ) : (
        <List
          items={commits}
          getKey={(c) => c.id}
          rowHeight={22}
          aria-label={tx(label)}
          className={styles.boxList}
          empty={<span>{emptyText}</span>}
          renderItem={(c) => (
            <span className={styles.commitRow} style={{ flex: 1, padding: 0 }}>
              <span className={styles.commitHash}>{c.shortId}</span>
              <span className={styles.commitSubject}>{c.summary}</span>
              <span className={styles.commitMeta}>{c.author}</span>
              <span className={styles.commitMeta}>{formatTime(c.timeMs)}</span>
            </span>
          )}
        />
      )}
    </div>
  );
}
