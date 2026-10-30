import { create } from "zustand";

export const useJjWindow = create<{ tab: string }>(() => ({ tab: "log" }));

export function selectJjLog() {
  useJjWindow.setState({ tab: "log" });
}
