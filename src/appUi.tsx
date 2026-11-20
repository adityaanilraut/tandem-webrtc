import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { X } from "lucide-react";
import type { RoomResponse } from "../shared/protocol";
import { requestJson } from "./api";

export function useCreateCall() {
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);

  async function createCall() {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setCreating(true);
    setError("");
    try {
      const data = await requestJson<RoomResponse>("/api/rooms", {
        method: "POST",
        signal: controller.signal,
      });
      if (!controller.signal.aborted)
        navigate(data.invitePath, { state: { startCreatedCall: true } });
    } catch (error) {
      if (!controller.signal.aborted)
        setError(
          error instanceof Error
            ? error.message
            : "The call server is unavailable. Please try again.",
        );
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setCreating(false);
    }
  }

  return { createCall, creating, error };
}

export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      className="dialog"
      ref={ref}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      aria-label={title}
    >
      <div className="dialog-heading">
        <h2>{title}</h2>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="Close dialog"
        >
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}

export function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="notice" role="alert">
      {children}
    </div>
  );
}
