// shadcn/ui's class merge helper: clsx for conditional classes, then
// tailwind-merge so later Tailwind utilities override earlier ones without
// surprises (e.g. rounded-sm rounded-lg keeps the last radius).
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}