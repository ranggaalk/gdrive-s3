import { useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Globe, HardDrive, LogOut, Menu, Moon, PanelLeftClose, PanelLeftOpen, Palette, Settings, ShieldCheck, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTheme } from "@/components/theme-provider";
import { ThemeColorDialog } from "@/components/theme-color-dialog";
import { LocaleDialog } from "@/components/locale-dialog";
import { useLocale } from "@/components/locale-provider";
import { cn } from "@/lib/utils";

const SIDEBAR_STORAGE_KEY = "drives3-sidebar-collapsed";

export type NavigationItem<T extends string> = {
  id: T;
  name: string;
  icon: LucideIcon;
};

function Navigation<T extends string>({
  items,
  active,
  onSelect,
  mobile = false,
  collapsed = false,
}: {
  items: Array<NavigationItem<T>>;
  active: T;
  onSelect: (id: T) => void;
  mobile?: boolean;
  collapsed?: boolean;
}) {
  const { t } = useLocale();
  return (
    <nav aria-label={t.nav.navigationLabel} className="grid gap-1.5">
      {items.map(({ id, name, icon: Icon }) => {
        const button = (
          <Button
            type="button"
            variant="ghost"
            className={cn(
              "w-full",
              collapsed ? "justify-center px-0" : "justify-start",
              active === id
                ? "bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
            aria-current={active === id ? "page" : undefined}
            aria-label={collapsed ? name : undefined}
            onClick={() => onSelect(id)}
          >
            <Icon />
            {collapsed ? null : name}
          </Button>
        );
        const content =
          collapsed && !mobile ? (
            <Tooltip>
              <TooltipTrigger asChild>{button}</TooltipTrigger>
              <TooltipContent side="right">{name}</TooltipContent>
            </Tooltip>
          ) : (
            button
          );
        return mobile ? <SheetClose asChild key={id}>{content}</SheetClose> : <div key={id}>{content}</div>;
      })}
    </nav>
  );
}

function GeneralAction({
  icon: Icon,
  label,
  collapsed,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  collapsed: boolean;
  onClick: () => void;
}) {
  const button = (
    <Button
      type="button"
      variant="ghost"
      className={cn("w-full text-muted-foreground hover:text-foreground", collapsed ? "justify-center px-0" : "justify-start")}
      aria-label={collapsed ? label : undefined}
      onClick={onClick}
    >
      <Icon />
      {collapsed ? null : label}
    </Button>
  );
  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
    );
  }
  return button;
}

export function AppShell<T extends string>({
  email,
  title,
  navigation,
  active,
  onSelect,
  onOpenSecurity,
  children,
}: {
  email: string;
  title: string;
  navigation: Array<NavigationItem<T>>;
  active: T;
  onSelect: (id: T) => void;
  onOpenSecurity: () => void;
  children: React.ReactNode;
}) {
  const { resolvedTheme, setTheme } = useTheme();
  const { t } = useLocale();
  const [collapsed, setCollapsed] = useState(
    () => window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === "1",
  );
  const [now, setNow] = useState(() => new Date());
  const [colorDialogOpen, setColorDialogOpen] = useState(false);
  const [localeDialogOpen, setLocaleDialogOpen] = useState(false);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(interval);
  }, []);

  const toggleTheme = () => setTheme(resolvedTheme === "dark" ? "light" : "dark");
  const logout = () => { window.location.href = "/auth/logout"; };
  const initial = email.slice(0, 1).toUpperCase();
  // "Pengaturan"/"Settings" only exists in `navigation` for admins (App.tsx
  // adds it conditionally), so this menu item naturally hides itself too.
  const settingsItem = navigation.find((item) => item.id === "settings");

  return (
    <TooltipProvider delayDuration={200}>
      <div className="min-h-screen bg-muted/40">
        <div className="flex w-full flex-col overflow-hidden bg-card lg:h-screen lg:flex-row">
          <aside
            className={cn(
              "hidden shrink-0 flex-col overflow-y-auto border-r bg-card p-3 transition-[width] duration-200 lg:flex lg:min-h-0",
              collapsed ? "w-16" : "w-64",
            )}
          >
            <div className={cn("flex items-center gap-2 px-2 py-4", collapsed && "justify-center px-0")}>
              <HardDrive className="size-6 shrink-0 text-primary" aria-hidden="true" />
              {collapsed ? null : <span className="truncate font-semibold">{t.nav.appName}</span>}
            </div>

            {collapsed ? null : (
              <p className="px-3 pb-3 pt-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">{t.nav.menuLabel}</p>
            )}
            <Navigation items={navigation} active={active} onSelect={onSelect} collapsed={collapsed} />

            <div className="mt-auto space-y-1.5 pt-6">
              {collapsed ? null : (
                <p className="px-3 pb-3 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">{t.nav.generalLabel}</p>
              )}
              <GeneralAction
                icon={resolvedTheme === "dark" ? Sun : Moon}
                label={resolvedTheme === "dark" ? t.nav.lightMode : t.nav.darkMode}
                collapsed={collapsed}
                onClick={toggleTheme}
              />
              <GeneralAction icon={Palette} label={t.nav.colorTheme} collapsed={collapsed} onClick={() => setColorDialogOpen(true)} />
              <GeneralAction icon={Globe} label={t.nav.language} collapsed={collapsed} onClick={() => setLocaleDialogOpen(true)} />
              <GeneralAction icon={LogOut} label={t.nav.logout} collapsed={collapsed} onClick={logout} />

              <div className={cn("flex items-center gap-2 pt-2", collapsed ? "justify-center" : "justify-between")}>
                {collapsed ? null : (
                  <span className="pl-2 font-mono text-xs tabular-nums text-muted-foreground">
                    {now.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })}
                  </span>
                )}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={collapsed ? t.nav.expandSidebar : t.nav.collapseSidebar}
                      onClick={() => setCollapsed((value) => !value)}
                    >
                      {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="right">{collapsed ? t.nav.expandSidebar : t.nav.collapseSidebar}</TooltipContent>
                </Tooltip>
              </div>
            </div>
          </aside>

          <div className="flex min-w-0 flex-1 flex-col lg:min-h-0">
            <header className="sticky top-0 z-10 shrink-0 border-b bg-card/95 backdrop-blur">
              <div className="flex h-16 items-center gap-3 px-4 sm:px-6">
                <Sheet>
                  <SheetTrigger asChild>
                    <Button type="button" size="icon" variant="ghost" className="lg:hidden" aria-label={t.nav.openNav}>
                      <Menu />
                    </Button>
                  </SheetTrigger>
                  <SheetContent>
                    <SheetHeader>
                      <SheetTitle className="flex items-center gap-2">
                        <HardDrive className="text-primary" /> {t.nav.appName}
                      </SheetTitle>
                    </SheetHeader>
                    <div className="mt-8 flex h-[calc(100vh-8rem)] flex-col">
                      <Navigation items={navigation} active={active} onSelect={onSelect} mobile />
                      <div className="mt-auto space-y-1 pt-4">
                        <SheetClose asChild>
                          <Button type="button" variant="ghost" className="w-full justify-start text-muted-foreground" onClick={toggleTheme}>
                            {resolvedTheme === "dark" ? <Sun /> : <Moon />}
                            {resolvedTheme === "dark" ? t.nav.lightMode : t.nav.darkMode}
                          </Button>
                        </SheetClose>
                        <SheetClose asChild>
                          <Button type="button" variant="ghost" className="w-full justify-start text-muted-foreground" onClick={() => setColorDialogOpen(true)}>
                            <Palette /> {t.nav.colorTheme}
                          </Button>
                        </SheetClose>
                        <SheetClose asChild>
                          <Button type="button" variant="ghost" className="w-full justify-start text-muted-foreground" onClick={() => setLocaleDialogOpen(true)}>
                            <Globe /> {t.nav.language}
                          </Button>
                        </SheetClose>
                        <SheetClose asChild>
                          <Button type="button" variant="ghost" className="w-full justify-start text-muted-foreground" onClick={logout}>
                            <LogOut /> {t.nav.logout}
                          </Button>
                        </SheetClose>
                      </div>
                    </div>
                  </SheetContent>
                </Sheet>

                <div className="flex min-w-0 items-center gap-2 font-semibold lg:hidden">
                  <HardDrive className="size-6 shrink-0 text-primary" aria-hidden="true" />
                  <span className="hidden sm:inline">{t.nav.appName}</span>
                </div>

                <div className="ml-auto flex min-w-0 items-center">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        aria-label={t.nav.accountMenu(email)}
                        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
                      >
                        {initial}
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuLabel className="max-w-56 truncate" title={email}>{email}</DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={onOpenSecurity}>
                        <ShieldCheck /> {t.nav.security}
                      </DropdownMenuItem>
                      {settingsItem ? (
                        <DropdownMenuItem onClick={() => onSelect(settingsItem.id)}>
                          <Settings /> {t.nav.settings}
                        </DropdownMenuItem>
                      ) : null}
                      <DropdownMenuItem onClick={logout}>
                        <LogOut /> {t.nav.logout}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            </header>

            <main className="flex-1 p-4 sm:p-6 lg:min-h-0 lg:overflow-y-auto lg:p-8">
              <div className="mx-auto w-full max-w-7xl space-y-6">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">{t.nav.controlPlane}</p>
                  <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
                </div>
                {children}
              </div>
            </main>
          </div>
        </div>
      </div>
      <ThemeColorDialog open={colorDialogOpen} onOpenChange={setColorDialogOpen} />
      <LocaleDialog open={localeDialogOpen} onOpenChange={setLocaleDialogOpen} />
    </TooltipProvider>
  );
}
