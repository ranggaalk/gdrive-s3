import type { LucideIcon } from "lucide-react";
import { HardDrive, LogOut, Menu, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useTheme } from "@/components/theme-provider";
import { cn } from "@/lib/utils";

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
}: {
  items: Array<NavigationItem<T>>;
  active: T;
  onSelect: (id: T) => void;
  mobile?: boolean;
}) {
  return (
    <nav aria-label="Navigasi utama" className="grid gap-1">
      {items.map(({ id, name, icon: Icon }) => {
        const content = (
          <Button
            type="button"
            variant="ghost"
            className={cn("w-full justify-start", active === id && "bg-accent text-accent-foreground")}
            aria-current={active === id ? "page" : undefined}
            onClick={() => onSelect(id)}
          >
            <Icon />
            {name}
          </Button>
        );
        return mobile ? <SheetClose asChild key={id}>{content}</SheetClose> : <div key={id}>{content}</div>;
      })}
    </nav>
  );
}

export function AppShell<T extends string>({
  email,
  title,
  navigation,
  active,
  onSelect,
  children,
}: {
  email: string;
  title: string;
  navigation: Array<NavigationItem<T>>;
  active: T;
  onSelect: (id: T) => void;
  children: React.ReactNode;
}) {
  const { resolvedTheme, setTheme } = useTheme();

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 border-b bg-card/95 backdrop-blur">
        <div className="flex h-16 items-center gap-3 px-4 sm:px-6">
          <Sheet>
            <SheetTrigger asChild>
              <Button type="button" size="icon" variant="ghost" className="lg:hidden" aria-label="Buka navigasi">
                <Menu />
              </Button>
            </SheetTrigger>
            <SheetContent>
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2">
                  <HardDrive className="text-primary" /> DriveS3 Gateway
                </SheetTitle>
              </SheetHeader>
              <div className="mt-8">
                <Navigation items={navigation} active={active} onSelect={onSelect} mobile />
              </div>
            </SheetContent>
          </Sheet>

          <div className="flex min-w-0 items-center gap-2 font-semibold">
            <HardDrive className="size-6 shrink-0 text-primary" aria-hidden="true" />
            <span className="hidden sm:inline">DriveS3 Gateway</span>
          </div>
          <div className="ml-auto flex min-w-0 items-center gap-1 sm:gap-2">
            <span className="hidden max-w-64 truncate text-sm text-muted-foreground md:block" title={email}>{email}</span>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label={resolvedTheme === "dark" ? "Gunakan tema terang" : "Gunakan tema gelap"}
              onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
            >
              {resolvedTheme === "dark" ? <Sun /> : <Moon />}
            </Button>
            <Button type="button" variant="ghost" onClick={() => { window.location.href = "/auth/logout"; }}>
              <LogOut />
              <span className="hidden sm:inline">Keluar</span>
            </Button>
          </div>
        </div>
      </header>

      <div className="lg:grid lg:grid-cols-[16rem_minmax(0,1fr)]">
        <aside className="sticky top-16 hidden h-[calc(100vh-4rem)] border-r bg-card p-4 lg:block">
          <Navigation items={navigation} active={active} onSelect={onSelect} />
        </aside>
        <main className="min-w-0 p-4 sm:p-6 lg:p-8">
          <div className="mx-auto w-full max-w-7xl space-y-6">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">Control plane</p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
            </div>
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
