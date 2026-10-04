import { Text, useApp } from "ink";
import { useEffect, useState } from "react";
import { DEFAULT_WORKSPACE_LABEL } from "./app/constants.js";
import {
  UserInteractionController,
  type UserInteractionState,
  type WorkspaceAccessMode,
} from "./app/user-interaction.js";
import { UserInteractionView } from "./app/user-interaction-view.js";
import { App, type AppProps } from "./app.js";
import { WorkspaceTrustStore, type WorkspaceTrustStoreContract } from "./workspace-trust.js";

export type CliRootProps = Omit<
  AppProps,
  "accessMode" | "userInteractionController" | "userInteractionState"
> & {
  readonly createUserInteractionController?:
    | ((
        onStateChange: (state: UserInteractionState | undefined) => void,
      ) => UserInteractionController)
    | undefined;
  readonly workspaceTrustStore?: WorkspaceTrustStoreContract | undefined;
};

export function CliRoot({
  createUserInteractionController,
  workspaceTrustStore: providedWorkspaceTrustStore,
  workspaceDir = DEFAULT_WORKSPACE_LABEL,
  ...appProps
}: CliRootProps) {
  const { exit } = useApp();
  const [accessMode, setAccessMode] = useState<WorkspaceAccessMode | undefined>();
  const [authorizationError, setAuthorizationError] = useState<string | undefined>();
  const [interactionState, setInteractionState] = useState<UserInteractionState | undefined>();
  const [controller] = useState(
    () =>
      createUserInteractionController?.(setInteractionState) ??
      new UserInteractionController({
        onStateChange: setInteractionState,
      }),
  );
  const [workspaceTrustStore] = useState(
    () => providedWorkspaceTrustStore ?? new WorkspaceTrustStore(),
  );

  useEffect(() => {
    let mounted = true;

    const authorizeWorkspace = async () => {
      try {
        const trusted = await workspaceTrustStore.get(workspaceDir);
        if (!mounted) {
          return;
        }
        if (trusted?.accessMode === "read-write") {
          setAccessMode("read-write");
          return;
        }

        const decision = await controller.requestWorkspaceAccess(workspaceDir);
        if (!mounted) {
          return;
        }
        if (decision.action === "exit") {
          appProps.onExitCode?.(0);
          exit();
          return;
        }
        if (decision.persistence === "persistent") {
          await workspaceTrustStore.trust(workspaceDir, decision.accessMode);
        }
        setAccessMode(decision.accessMode);
      } catch (error) {
        if (mounted) {
          setAuthorizationError(error instanceof Error ? error.message : String(error));
          appProps.onExitCode?.(1);
        }
      }
    };

    void authorizeWorkspace();

    return () => {
      mounted = false;
      controller.cancelAll();
    };
  }, [appProps.onExitCode, controller, exit, workspaceDir, workspaceTrustStore]);

  if (accessMode === undefined) {
    if (authorizationError !== undefined) {
      return <Text color="red">Workspace authorization failed: {authorizationError}</Text>;
    }
    return interactionState === undefined ? null : (
      <UserInteractionView controller={controller} state={interactionState} />
    );
  }

  return (
    <App
      {...appProps}
      accessMode={accessMode}
      migrateLegacy
      persistWorkspaceWriteAccess={() =>
        workspaceTrustStore.trust(workspaceDir, "read-write").then(() => undefined)
      }
      userInteractionController={controller}
      userInteractionState={interactionState}
      workspaceDir={workspaceDir}
    />
  );
}
