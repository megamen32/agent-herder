import React from "react";

import type { SettingsChanges, SettingsProfile, SettingsProject, SettingsView } from "./settings-client.js";

/**
 * The projects of the mesh and the AI profiles they run in.
 *
 * The ownership is split and the form shows it: the AI profile belongs to
 * the herder and is created here, while the rule of the escalation belongs
 * to the Notice Place — the project keeps the reference to the object of the
 * center, and the form never shows or edits a copy of the rule.
 *
 * The profile of a project is a reference by id: a route of the launch
 * policy names the same profile, and the reference survives the save.
 */

export type ProfileDraft = {
  id: string;
  humanName: string;
  harness: string;
  model: string;
  fallbackModels: string;
};

export type ProjectDraft = {
  id: string;
  name: string;
  path: string;
  profileId: string;
  escalationObjectId: string;
};

export function profileDrafts(profiles: SettingsProfile[]): ProfileDraft[] {
  return profiles.map((profile) => ({
    id: profile.id,
    humanName: profile.humanName ?? profile.id,
    harness: profile.harness ?? "",
    model: profile.model ?? "",
    fallbackModels: (profile.fallbackModels ?? []).join(", "),
  }));
}

export function projectDrafts(projects: SettingsProject[]): ProjectDraft[] {
  return projects.map((project) => ({
    id: project.id,
    name: project.name,
    path: project.path,
    profileId: project.profileId ?? "",
    escalationObjectId: project.escalation?.noticePlaceObjectId ?? "",
  }));
}

/** The profiles and the projects as the API takes them. */
export function changesOf(profiles: ProfileDraft[], projects: ProjectDraft[]): SettingsChanges {
  return {
    profiles: profiles.map((profile) => ({
      id: profile.id,
      humanName: profile.humanName.trim() || profile.id,
      action: "Профиль ИИ: среда, модель и запасные модели.",
      scope: { kind: "mesh" },
      harness: profile.harness.trim() || "codex",
      ...(profile.model.trim() ? { model: profile.model.trim() } : {}),
      ...(profile.fallbackModels.trim()
        ? { fallbackModels: profile.fallbackModels.split(",").map((item) => item.trim()).filter(Boolean) }
        : {}),
    })),
    projects: projects.map((project) => ({
      id: project.id,
      name: project.name.trim() || project.id,
      path: project.path.trim(),
      ...(project.profileId.trim() ? { profileId: project.profileId.trim() } : {}),
      ...(project.escalationObjectId.trim()
        ? { escalation: { noticePlaceObjectId: project.escalationObjectId.trim() } }
        : {}),
    })),
  };
}

/** The records of the profiles and the projects: the precondition of the change. */
export function editedRecordIds(profiles: ProfileDraft[], projects: ProjectDraft[]): string[] {
  return [
    ...profiles.map((profile) => `node-config/profile/${profile.id}`),
    ...projects.map((project) => `project/${project.id}`),
  ];
}

export function ProjectsSection({
  view,
  onSave,
}: {
  view: SettingsView;
  onSave: (changes: SettingsChanges, ids: string[]) => Promise<void>;
}): React.ReactElement {
  const [profiles, setProfiles] = React.useState<ProfileDraft[]>(() => profileDrafts(view.profiles ?? []));
  const [projects, setProjects] = React.useState<ProjectDraft[]>(() => projectDrafts(view.projects ?? []));

  // The answer of the server is the truth: the drafts follow the records.
  React.useEffect(() => {
    setProfiles(profileDrafts(view.profiles ?? []));
    setProjects(projectDrafts(view.projects ?? []));
  }, [view.profiles, view.projects]);

  const addProfile = (): void => {
    setProfiles((previous) => [...previous, { id: `profile-${previous.length + 1}`, humanName: "", harness: "codex", model: "", fallbackModels: "" }]);
  };
  const addProject = (): void => {
    setProjects((previous) => [...previous, { id: `project-${previous.length + 1}`, name: "", path: "", profileId: "", escalationObjectId: "" }]);
  };

  const save = async (): Promise<void> => {
    await onSave(changesOf(profiles, projects), editedRecordIds(profiles, projects));
  };

  return (
    <section className="herder-settings-block" id="herder-projects" aria-label="Проекты и профили ИИ">
      <h2>Проекты и профили ИИ</h2>
      <p className="herder-settings-hint">
        Профиль ИИ принадлежит herder и создаётся здесь. Правило эскалации принадлежит Notice Place: проект хранит
        ссылку на объект центра, второй копии правила здесь не возникает.
      </p>

      <h3>Профили ИИ</h3>
      <div className="herder-settings-actions">
        <button type="button" className="herder-settings-button" onClick={addProfile}>Создать профиль</button>
      </div>
      {profiles.length ? (
        <table className="herder-settings-table">
          <thead>
            <tr><th>Идентификатор</th><th>Название</th><th>Среда</th><th>Модель</th><th>Запасные модели</th></tr>
          </thead>
          <tbody>
            {profiles.map((profile, index) => (
              <tr key={profile.id}>
                <td><code>{profile.id}</code></td>
                <td>
                  <input
                    value={profile.humanName}
                    onChange={(event) => setProfiles((previous) => previous.map((item, position) => position === index ? { ...item, humanName: event.target.value } : item))}
                    aria-label={`Название профиля ${profile.id}`}
                  />
                </td>
                <td>
                  <input
                    value={profile.harness}
                    onChange={(event) => setProfiles((previous) => previous.map((item, position) => position === index ? { ...item, harness: event.target.value } : item))}
                    aria-label={`Среда профиля ${profile.id}`}
                  />
                </td>
                <td>
                  <input
                    value={profile.model}
                    onChange={(event) => setProfiles((previous) => previous.map((item, position) => position === index ? { ...item, model: event.target.value } : item))}
                    aria-label={`Модель профиля ${profile.id}`}
                  />
                </td>
                <td>
                  <input
                    value={profile.fallbackModels}
                    onChange={(event) => setProfiles((previous) => previous.map((item, position) => position === index ? { ...item, fallbackModels: event.target.value } : item))}
                    aria-label={`Запасные модели профиля ${profile.id}`}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="herder-settings-hint">Профилей ИИ пока нет.</p>
      )}

      <h3>Проекты</h3>
      <div className="herder-settings-actions">
        <button type="button" className="herder-settings-button" onClick={addProject}>Создать проект</button>
      </div>
      {projects.length ? (
        <table className="herder-settings-table">
          <thead>
            <tr><th>Идентификатор</th><th>Название</th><th>Каталог</th><th>Профиль ИИ</th><th>Объект эскалации в центре</th></tr>
          </thead>
          <tbody>
            {projects.map((project, index) => (
              <tr key={project.id}>
                <td><code>{project.id}</code></td>
                <td>
                  <input
                    value={project.name}
                    onChange={(event) => setProjects((previous) => previous.map((item, position) => position === index ? { ...item, name: event.target.value } : item))}
                    aria-label={`Название проекта ${project.id}`}
                  />
                </td>
                <td>
                  <input
                    value={project.path}
                    onChange={(event) => setProjects((previous) => previous.map((item, position) => position === index ? { ...item, path: event.target.value } : item))}
                    aria-label={`Каталог проекта ${project.id}`}
                  />
                </td>
                <td>
                  <select
                    value={project.profileId}
                    onChange={(event) => setProjects((previous) => previous.map((item, position) => position === index ? { ...item, profileId: event.target.value } : item))}
                    aria-label={`Профиль ИИ проекта ${project.id}`}
                  >
                    <option value="">— без профиля —</option>
                    {profiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>{profile.humanName || profile.id}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    value={project.escalationObjectId}
                    onChange={(event) => setProjects((previous) => previous.map((item, position) => position === index ? { ...item, escalationObjectId: event.target.value } : item))}
                    placeholder="идентификатор объекта"
                    aria-label={`Объект эскалации проекта ${project.id}`}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="herder-settings-hint">Проектов пока нет.</p>
      )}

      <div className="herder-settings-actions">
        <button type="button" className="herder-settings-button" onClick={() => { void save(); }}>Сохранить проекты и профили</button>
      </div>
      <p className="herder-settings-hint">
        После сохранения подтверждённое состояние каждой записи видно в таблице «Записи настроек» ниже.
      </p>
    </section>
  );
}
