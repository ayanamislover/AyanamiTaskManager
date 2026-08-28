import { useEffect, useRef, useState } from "react";
import { cancelNoticeTimer, restartNoticeTimer } from "../notice-lifecycle.js";

export function useNotice() {
  const [notice, setNotice] = useState("");
  const noticeTimerRef = useRef<number | null>(null);
  const notify = (message: string) => {
    setNotice(message);
    restartNoticeTimer(noticeTimerRef, () => setNotice(""));
  };
  useEffect(() => () => cancelNoticeTimer(noticeTimerRef), []);
  return { notice, notify };
}
