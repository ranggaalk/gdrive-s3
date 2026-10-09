import { useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Globe, HardDrive, LogOut, Menu, Moon, PanelLeftClose, PanelLeftOpen, Palette, Settings, ShieldCheck, Sun } from "lucide-react";
import { Button, Drawer, Dropdown, Header, Label, Separator, Tooltip } from "@heroui/react";
import { useTheme } from "@/components/theme-provider";
import { ThemeColorDialog } from "@/components/theme-color-dialog";
import { LocaleDialog } from "@/components/locale-dialog";
import { useLocale } from "@/components/locale-provider";
import { cn } from "@/lib/utils";

const SIDEBAR_STORAGE_KEY = "drives3-sidebar-collapsed";
const TOOLTIP_DELAY = 200;

export type NavigationItem<T extends string> = {
  id: T;
  name: string;
  icon: LucideIcon;
};

function Navigation<T extends string>({
  items,
  active,
  onSelect,
  collapsed = false,
}: {
  items: Array<NavigationItem<T>>;
  active: T;
  onSelect: (id: T) => void;
  collapsed?: boolean;
}) {
  const { t } = useLocale();
  return (
    <nav aria-label={t.nav.navigationLabel} className="grid gap-1.5">
      {items.map(({ id, name, icon: Icon }) => {
        const button = (
          <Button
            variant={active === id ? "primary" : "ghost"}
            fullWidth
            className={cn(
              collapsed ? "justify-center px-0" : "justify-start",
              active === id ? "" : "text-muted hover:text-foreground",
            )}
            aria-current={active === id ? "page" : undefined}
            aria-label={collapsed ? name : undefined}
            onPress={() => onSelect(id)}
          >
            <Icon />
            {collapsed ? null : name}
          </Button>
        );
        return (
          <div key={id}>
            {collapsed ? (
              // The Button itself is the trigger: Tooltip.Trigger would wrap it
              // in a second focusable role="button" element.
              <Tooltip delay={TOOLTIP_DELAY}>
                {button}
                <Tooltip.Content placement="right">{name}</Tooltip.Content>
              </Tooltip>
            ) : (
              button
            )}
          </div>
        );
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
      variant="ghost"
      fullWidth
      className={cn("text-muted hover:text-foreground", collapsed ? "justify-center px-0" : "justify-start")}
      aria-label={collapsed ? label : undefined}
      onPress={onClick}
    >
      <Icon />
      {collapsed ? null : label}
    </Button>
  );
  if (collapsed) {
    return (
      <Tooltip delay={TOOLTIP_DELAY}>
        {button}
        <Tooltip.Content placement="right">{label}</Tooltip.Content>
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
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

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
  // Every entry in the mobile drawer navigates or opens a dialog, so each one
  // closes the drawer first -- the job SheetClose used to do per button.
  const fromDrawer = (action: () => void) => () => {
    setMobileNavOpen(false);
    action();
  };

  return (
    <>
      <div className="min-h-screen bg-background">
        <div className="flex w-full flex-col overflow-hidden lg:h-screen lg:flex-row">
          <aside
            className={cn(
              "hidden shrink-0 flex-col overflow-y-auto border-r border-separator bg-surface p-3 transition-[width] duration-200 lg:flex lg:min-h-0",
              collapsed ? "w-16" : "w-64",
            )}
          >
            <div className={cn("flex items-center gap-2 px-2 py-4", collapsed && "justify-center px-0")}>
              <HardDrive className="size-6 shrink-0 text-accent" aria-hidden="true" />
              {collapsed ? null : <span className="truncate font-semibold">{t.nav.appName}</span>}
            </div>

            {collapsed ? null : (
              <p className="px-3 pb-3 pt-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted">{t.nav.menuLabel}</p>
            )}
            <Navigation items={navigation} active={active} onSelect={onSelect} collapsed={collapsed} />

            <div className="mt-auto space-y-1.5 pt-6">
              {collapsed ? null : (
                <p className="px-3 pb-3 text-xs font-semibold uppercase tracking-[0.16em] text-muted">{t.nav.generalLabel}</p>
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
                  <span className="pl-2 font-mono text-xs tabular-nums text-muted">
                    {now.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })}
                  </span>
                )}
                <Tooltip delay={TOOLTIP_DELAY}>
                  <Button
                    isIconOnly
                    variant="ghost"
                    aria-label={collapsed ? t.nav.expandSidebar : t.nav.collapseSidebar}
                    onPress={() => setCollapsed((value) => !value)}
                  >
                    {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
                  </Button>
                  <Tooltip.Content placement="right">{collapsed ? t.nav.expandSidebar : t.nav.collapseSidebar}</Tooltip.Content>
                </Tooltip>
              </div>
            </div>
          </aside>

          <div className="flex min-w-0 flex-1 flex-col lg:min-h-0">
            <header className="sticky top-0 z-10 shrink-0 border-b border-separator bg-surface/95 backdrop-blur-sm">
              <div className="flex h-16 items-center gap-3 px-4 sm:px-6">
                <Button isIconOnly variant="ghost" className="lg:hidden" aria-label={t.nav.openNav} onPress={() => setMobileNavOpen(true)}>
                  <Menu />
                </Button>

                <div className="flex min-w-0 items-center gap-2 font-semibold lg:hidden">
                  <HardDrive className="size-6 shrink-0 text-accent" aria-hidden="true" />
                  <span className="hidden sm:inline">{t.nav.appName}</span>
                </div>

                <div className="ml-auto flex min-w-0 items-center">
                  <Dropdown>
                    <Dropdown.Trigger
                      aria-label={t.nav.accountMenu(email)}
                      className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90"
                    >
                      {initial}
                    </Dropdown.Trigger>
                    <Dropdown.Popover placement="bottom end" className="min-w-56">
                      <Dropdown.Menu aria-label={t.nav.accountMenu(email)}>
                        <Dropdown.Section>
                          <Header className="max-w-56 truncate" title={email}>{email}</Header>
                          <Dropdown.Item id="security" textValue={t.nav.security} onAction={onOpenSecurity}>
                            <ShieldCheck className="size-4 shrink-0" />
                            <Label>{t.nav.security}</Label>
                          </Dropdown.Item>
                          {settingsItem ? (
                            <Dropdown.Item id="settings" textValue={t.nav.settings} onAction={() => onSelect(settingsItem.id)}>
                              <Settings className="size-4 shrink-0" />
                              <Label>{t.nav.settings}</Label>
                            </Dropdown.Item>
                          ) : null}
                        </Dropdown.Section>
                        <Separator />
                        <Dropdown.Item id="logout" textValue={t.nav.logout} onAction={logout}>
                          <LogOut className="size-4 shrink-0" />
                          <Label>{t.nav.logout}</Label>
                        </Dropdown.Item>
                      </Dropdown.Menu>
                    </Dropdown.Popover>
                  </Dropdown>
                </div>
              </div>
            </header>

            <main className="flex-1 p-4 sm:p-6 lg:min-h-0 lg:overflow-y-auto lg:p-8">
              <div className="mx-auto w-full max-w-7xl space-y-6">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent">{t.nav.controlPlane}</p>
                  <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
                </div>
                {children}
              </div>
            </main>
          </div>
        </div>
      </div>
      <Drawer.Backdrop isOpen={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <Drawer.Content placement="left" className="w-80 max-w-[85vw]">
          <Drawer.Dialog>
            <Drawer.CloseTrigger aria-label={t.common.close} />
            <Drawer.Header>
              <Drawer.Heading className="flex items-center gap-2">
                <HardDrive className="size-5 text-accent" aria-hidden="true" /> {t.nav.appName}
              </Drawer.Heading>
            </Drawer.Header>
            <Drawer.Body className="flex flex-col">
              <Navigation items={navigation} active={active} onSelect={(id) => { setMobileNavOpen(false); onSelect(id); }} />
              <div className="mt-auto space-y-1 pt-4">
                <Button variant="ghost" fullWidth className="justify-start text-muted" onPress={fromDrawer(toggleTheme)}>
                  {resolvedTheme === "dark" ? <Sun /> : <Moon />}
                  {resolvedTheme === "dark" ? t.nav.lightMode : t.nav.darkMode}
                </Button>
                <Button variant="ghost" fullWidth className="justify-start text-muted" onPress={fromDrawer(() => setColorDialogOpen(true))}>
                  <Palette /> {t.nav.colorTheme}
                </Button>
                <Button variant="ghost" fullWidth className="justify-start text-muted" onPress={fromDrawer(() => setLocaleDialogOpen(true))}>
                  <Globe /> {t.nav.language}
                </Button>
                <Button variant="ghost" fullWidth className="justify-start text-muted" onPress={fromDrawer(logout)}>
                  <LogOut /> {t.nav.logout}
                </Button>
              </div>
            </Drawer.Body>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
      <ThemeColorDialog open={colorDialogOpen} onOpenChange={setColorDialogOpen} />
      <LocaleDialog open={localeDialogOpen} onOpenChange={setLocaleDialogOpen} />
    </>
  );
}
