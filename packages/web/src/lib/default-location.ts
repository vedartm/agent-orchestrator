import { homedir } from "node:os";

export function getDefaultCloneLocation(): string {
  return homedir();
}
