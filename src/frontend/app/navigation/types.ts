import type { LocaleKey } from "@frontend/app/locale/locale-provider";
import type { LucideIcon } from "lucide-react";
import type { ComponentType } from "react";

export type RouteId =
  | "project-home"
  | "model"
  | "proofreading"
  | "workbench"
  | "basic-settings"
  | "expert-settings"
  | "glossary"
  | "text-preserve"
  | "text-replacement"
  | "pre-translation-replacement"
  | "post-translation-replacement"
  | "custom-prompt"
  | "translation-prompt"
  | "analysis-prompt"
  | "laboratory"
  | "toolbox"
  | "ts-conversion"
  | "fate-extra"
  | "fate-extra-preview";

type NavigationNode = {
  id: RouteId;
  icon: LucideIcon;
  title_key: LocaleKey;
  children?: NavigationNode[];
};

export type NavigationGroup = {
  id: string;
  items: NavigationNode[];
};

export type BottomActionId = "theme" | "language" | "logs";

export const THEME_PREFERENCES = ["system", "light", "dark"] as const;

export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export type AppearanceMenuActionId = "font-family";

export function is_theme_preference(value: unknown): value is ThemePreference {
  return THEME_PREFERENCES.includes(value as ThemePreference);
}

export type BottomAction = {
  id: BottomActionId;
  label_key: LocaleKey;
  icon: LucideIcon;
};

export type ScreenComponentProps = {
  is_sidebar_collapsed: boolean;
};

type ScreenModule = {
  component: ComponentType<ScreenComponentProps>;
  title_key: LocaleKey;
};

export type ScreenRegistry = Partial<Record<RouteId, ScreenModule>>;
