import { createContext, useContext, type ReactNode } from "react";
import type {
  Session,
  ProjectMembership,
  PublicUser,
  RuntimeMode,
} from "../shared/types";

export type Membership = ProjectMembership;
export type Identity = PublicUser;
export interface Access {
  user?: Identity;
  mode: RuntimeMode;
  isAdmin: boolean;
  canOperate: (projectId?: string) => boolean;
  canView: (projectId?: string) => boolean;
}
export function accessFor(
  user?: Session["user"],
  mode: RuntimeMode = "docker",
): Access {
  const identity = user;
  const isAdmin =
    !identity?.disabled &&
    (identity?.role === "owner" || identity?.role === "admin");
  return {
    user: identity,
    mode,
    isAdmin,
    canOperate: (projectId) =>
      isAdmin ||
      (!identity?.disabled &&
        !!identity?.memberships?.some(
          (m) => m.projectId === projectId && m.role === "operator",
        )),
    canView: (projectId) =>
      isAdmin ||
      (!identity?.disabled &&
        !!identity?.memberships?.some((m) => m.projectId === projectId)),
  };
}
const AccessContext = createContext<Access>(accessFor());
export const useAccess = () => useContext(AccessContext);
export function AccessProvider({
  user,
  mode,
  children,
}: {
  user?: Session["user"];
  mode?: RuntimeMode;
  children: ReactNode;
}) {
  return (
    <AccessContext.Provider value={accessFor(user, mode)}>
      {children}
    </AccessContext.Provider>
  );
}
