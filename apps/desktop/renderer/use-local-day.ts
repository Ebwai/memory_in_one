import { useEffect, useState } from "react";
import { localCalendarDate } from "@workspace/todo-list";

export function useLocalDay(): string {
  const [today, setToday] = useState(() => localCalendarDate(new Date()));
  useEffect(() => {
    const refresh = () => setToday(localCalendarDate(new Date()));
    // A small clock check also catches clock/timezone changes and sleep while this window stays focused.
    const timer = window.setInterval(refresh, 1000);
    window.addEventListener("focus", refresh);
    window.addEventListener("pageshow", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); window.removeEventListener("pageshow", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, []);
  return today;
}
