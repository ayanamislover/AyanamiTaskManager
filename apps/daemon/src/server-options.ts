import type { AyanamiTaskService } from "@ayanami-task/application";

export type AyanamiServerOptions = {
  service: AyanamiTaskService;
  token: string;
};
