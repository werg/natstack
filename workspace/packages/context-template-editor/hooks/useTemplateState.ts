/**
 * Hook for managing context template editor state.
 */

import { useState, useCallback, useMemo } from "react";
import type {
  EditorTemplateState,
  MountPoint,
  RefSelection,
  ContextTemplateYaml,
} from "../types";
import {
  generateMountId,
  defaultMountPath,
  parseGitSpec,
  stateToYaml,
} from "../types";

export interface UseTemplateStateOptions {
  /** Initial template for editing */
  initialTemplate?: ContextTemplateYaml;
  /** Project name for auto-generating template name */
  projectName: string;
  /** Inherited mount points from parent template */
  inheritedMounts?: MountPoint[];
  /** Called when state changes */
  onChange?: (template: ContextTemplateYaml, isValid: boolean) => void;
}

export interface UseTemplateStateResult {
  /** Current editor state */
  state: EditorTemplateState;
  /** All mount points (user + inherited) */
  allMountPoints: MountPoint[];
  /** Validation errors */
  errors: ValidationError[];
  /** Whether the template is valid */
  isValid: boolean;
  /** Set the parent template (extends) */
  setExtends: (spec: string | undefined) => void;
  /** Set description */
  setDescription: (description: string) => void;
  /** Add a new mount point */
  addMountPoint: (repoSpec: string) => void;
  /** Remove a mount point */
  removeMountPoint: (id: string) => void;
  /** Update a mount point's path */
  updateMountPath: (id: string, path: string) => void;
  /** Update a mount point's ref */
  updateMountRef: (id: string, ref: RefSelection) => void;
  /** Get the template as YAML */
  getYaml: () => ContextTemplateYaml;
}

export interface ValidationError {
  type: "path" | "conflict" | "duplicate";
  mountId: string;
  message: string;
}

export function useTemplateState(options: UseTemplateStateOptions): UseTemplateStateResult {
  const { initialTemplate, projectName, inheritedMounts = [], onChange } = options;

  // Parse initial template into state
  const initialState = useMemo((): EditorTemplateState => {
    const userMounts: MountPoint[] = [];

    if (initialTemplate?.structure) {
      for (const [path, spec] of Object.entries(initialTemplate.structure)) {
        const { repoSpec, ref } = parseGitSpec(spec);
        userMounts.push({
          id: generateMountId(),
          path,
          repoSpec,
          ref,
          isInherited: false,
        });
      }
    }

    return {
      name: initialTemplate?.name ?? projectName,
      description: initialTemplate?.description,
      extends: initialTemplate?.extends,
      mountPoints: userMounts,
    };
  }, [initialTemplate, projectName]);

  const [state, setState] = useState<EditorTemplateState>(initialState);

  // Combine user mounts with inherited mounts
  const allMountPoints = useMemo(() => {
    const inherited = inheritedMounts.map(mp => ({ ...mp, isInherited: true }));
    return [...state.mountPoints, ...inherited];
  }, [state.mountPoints, inheritedMounts]);

  // Validate mount points
  const errors = useMemo((): ValidationError[] => {
    const errs: ValidationError[] = [];
    const seenPaths = new Map<string, string>(); // path -> mount id

    // Check inherited paths first
    for (const mp of inheritedMounts) {
      seenPaths.set(mp.path, mp.id);
    }

    // Check user paths
    for (const mp of state.mountPoints) {
      // Path validation
      if (!mp.path.startsWith("/")) {
        errs.push({
          type: "path",
          mountId: mp.id,
          message: "Path must start with /",
        });
      } else if (mp.path.includes("..")) {
        errs.push({
          type: "path",
          mountId: mp.id,
          message: "Path cannot contain ..",
        });
      } else if (/^[A-Za-z]:/.test(mp.path)) {
        errs.push({
          type: "path",
          mountId: mp.id,
          message: "Windows paths not allowed",
        });
      }

      // Check for conflicts with inherited
      const inheritedId = seenPaths.get(mp.path);
      if (inheritedId && inheritedMounts.some(im => im.id === inheritedId)) {
        errs.push({
          type: "conflict",
          mountId: mp.id,
          message: "Path conflicts with inherited mount",
        });
      }

      // Check for duplicates among user mounts
      if (seenPaths.has(mp.path) && !inheritedMounts.some(im => im.id === seenPaths.get(mp.path))) {
        errs.push({
          type: "duplicate",
          mountId: mp.id,
          message: "Duplicate path",
        });
      }

      seenPaths.set(mp.path, mp.id);
    }

    return errs;
  }, [state.mountPoints, inheritedMounts]);

  const isValid = errors.length === 0;

  // Notify parent of changes
  const notifyChange = useCallback((newState: EditorTemplateState, newErrors: ValidationError[]) => {
    if (onChange) {
      const yaml = stateToYaml(newState);
      onChange(yaml, newErrors.length === 0);
    }
  }, [onChange]);

  const setExtends = useCallback((spec: string | undefined) => {
    setState(prev => {
      const next = { ...prev, extends: spec };
      notifyChange(next, errors);
      return next;
    });
  }, [notifyChange, errors]);

  const setDescription = useCallback((description: string) => {
    setState(prev => {
      const next = { ...prev, description: description || undefined };
      notifyChange(next, errors);
      return next;
    });
  }, [notifyChange, errors]);

  const addMountPoint = useCallback((repoSpec: string) => {
    setState(prev => {
      const newMount: MountPoint = {
        id: generateMountId(),
        path: defaultMountPath(repoSpec),
        repoSpec,
        ref: { type: "latest" },
        isInherited: false,
      };
      const next = {
        ...prev,
        mountPoints: [...prev.mountPoints, newMount],
      };
      notifyChange(next, errors);
      return next;
    });
  }, [notifyChange, errors]);

  const removeMountPoint = useCallback((id: string) => {
    setState(prev => {
      const next = {
        ...prev,
        mountPoints: prev.mountPoints.filter(mp => mp.id !== id),
      };
      notifyChange(next, errors);
      return next;
    });
  }, [notifyChange, errors]);

  const updateMountPath = useCallback((id: string, path: string) => {
    setState(prev => {
      const next = {
        ...prev,
        mountPoints: prev.mountPoints.map(mp =>
          mp.id === id ? { ...mp, path } : mp
        ),
      };
      notifyChange(next, errors);
      return next;
    });
  }, [notifyChange, errors]);

  const updateMountRef = useCallback((id: string, ref: RefSelection) => {
    setState(prev => {
      const next = {
        ...prev,
        mountPoints: prev.mountPoints.map(mp =>
          mp.id === id ? { ...mp, ref } : mp
        ),
      };
      notifyChange(next, errors);
      return next;
    });
  }, [notifyChange, errors]);

  const getYaml = useCallback(() => {
    return stateToYaml(state);
  }, [state]);

  return {
    state,
    allMountPoints,
    errors,
    isValid,
    setExtends,
    setDescription,
    addMountPoint,
    removeMountPoint,
    updateMountPath,
    updateMountRef,
    getYaml,
  };
}
