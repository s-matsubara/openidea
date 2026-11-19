import type { Action } from "@/platform/actions";
import { getContext } from "@/platform/context";
import { toolWindowService } from "@/workbench/contributions";
import { openDialog } from "./dialogs";
import { JjPushDialog } from "./JjPushDialog";
import { showJjRemoteDialog } from "./jjMenuDialogs";
import { selectJjLog } from "./jjWindowState";
import { openGitPushDialog, type PushTarget } from "./remoteUi";
import { refreshNow, useVcs } from "./store";

function showJjPushDialog() {
  openDialog((close) => <JjPushDialog onClose={close} />);
}

export async function showContextualPushDialog(target: PushTarget = {}) {
  await refreshNow();
  const { jjRoots, available } = useVcs.getState();
  if (!target.branch && !target.revision && jjRoots.length && (!available || getContext().vcsJjPath)) {
    showJjPushDialog();
  } else {
    openGitPushDialog(target);
  }
}

export const jjActions: Action[] = [
  {
    id: "vcs.jjPush",
    title: "Push Jujutsu Bookmarks or Tags…",
    category: "Jujutsu",
    icon: "git-push",
    when: "vcsJjAvailable",
    run: showJjPushDialog,
  },
  {
    id: "vcs.jjPull",
    title: "Pull…",
    category: "Jujutsu",
    icon: "git-pull",
    when: "vcsJjAvailable",
    run: () => showJjRemoteDialog("pull", openDialog),
  },
  {
    id: "vcs.jjFetch",
    title: "Fetch",
    category: "Jujutsu",
    icon: "git-fetch",
    when: "vcsJjAvailable",
    run: () => showJjRemoteDialog("fetch", openDialog),
  },
  {
    id: "vcs.jjRebase",
    title: "Rebase…",
    category: "Jujutsu",
    when: "vcsJjAvailable",
    run: () => showJjRemoteDialog("rebase", openDialog),
  },
  {
    id: "vcs.showJjHistory",
    title: "Show Jujutsu History",
    category: "Jujutsu",
    icon: "history",
    when: "vcsJjAvailable",
    run: () => {
      selectJjLog();
      toolWindowService().show("jujutsu", true);
    },
  },
];
