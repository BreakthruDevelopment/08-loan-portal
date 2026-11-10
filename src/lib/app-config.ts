/**
 * The one place an app names itself. The header, the page title and the sign-in
 * page all read APP_TITLE. Set APP_NAME in the environment, or change the default
 * below when an app is created from the template.
 */
export const APP_TITLE = process.env.APP_NAME || "Loan Application Portal";

export const APP_DESCRIPTION = "Part of the Breakthru Ventures 30 apps in 30 days portfolio.";

export const PARENT_SITE = { href: "https://breakthruventures.ai", label: "Explore breakthruventures.ai" };

/** Header navigation. `roles` limits who sees a link; every page still enforces its role on the server. */
export const NAV_LINKS: { href: string; label: string; roles: ("user" | "underwriter" | "admin")[] }[] = [
  { href: "/applications", label: "Applications", roles: ["user"] },
  { href: "/queue", label: "Queue", roles: ["underwriter"] },
  { href: "/admin", label: "Admin", roles: ["admin"] },
  { href: "/admin/audit", label: "Audit log", roles: ["admin"] },
];
