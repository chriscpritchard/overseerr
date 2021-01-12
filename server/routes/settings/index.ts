import { Router } from 'express';
import {
  getSettings,
  RadarrSettings,
  SonarrSettings,
  Library,
  MainSettings,
  PlexStatus,
} from '../../lib/settings';
import { getRepository } from 'typeorm';
import { User } from '../../entity/User';
import PlexAPI from '../../api/plexapi';
import PlexTvAPI from '../../api/plextv';
import { jobPlexFullSync } from '../../job/plexsync';
import SonarrAPI from '../../api/sonarr';
import RadarrAPI from '../../api/radarr';
import logger from '../../logger';
import { scheduledJobs } from '../../job/schedule';
import { Permission } from '../../lib/permissions';
import { isAuthenticated } from '../../middleware/auth';
import { merge, omit } from 'lodash';
import Media from '../../entity/Media';
import { MediaRequest } from '../../entity/MediaRequest';
import { getAppVersion } from '../../utils/appVersion';
import { SettingsAboutResponse } from '../../interfaces/api/settingsInterfaces';
import notificationRoutes from './notifications';

const settingsRoutes = Router();

settingsRoutes.use('/notifications', notificationRoutes);

const filteredMainSettings = (
  user: User,
  main: MainSettings
): Partial<MainSettings> => {
  if (!user?.hasPermission(Permission.ADMIN)) {
    return omit(main, 'apiKey');
  }

  return main;
};

settingsRoutes.get('/main', (req, res, next) => {
  const settings = getSettings();

  if (!req.user) {
    return next({ status: 500, message: 'User missing from request' });
  }

  res.status(200).json(filteredMainSettings(req.user, settings.main));
});

settingsRoutes.post('/main', (req, res) => {
  const settings = getSettings();

  settings.main = merge(settings.main, req.body);
  settings.save();

  return res.status(200).json(settings.main);
});

settingsRoutes.get('/main/regenerate', (req, res, next) => {
  const settings = getSettings();

  const main = settings.regenerateApiKey();

  if (!req.user) {
    return next({ status: 500, message: 'User missing from request' });
  }

  return res.status(200).json(filteredMainSettings(req.user, main));
});

settingsRoutes.get('/plex', (_req, res) => {
  const settings = getSettings();

  res.status(200).json(settings.plex);
});

settingsRoutes.post('/plex', async (req, res, next) => {
  const userRepository = getRepository(User);
  const settings = getSettings();
  try {
    const admin = await userRepository.findOneOrFail({
      select: ['id', 'plexToken'],
      order: { id: 'ASC' },
    });

    Object.assign(settings.plex, req.body);

    const plexClient = new PlexAPI({ plexToken: admin.plexToken });

    const result = await plexClient.getStatus();

    if (result?.MediaContainer?.machineIdentifier) {
      settings.plex.machineId = result.MediaContainer.machineIdentifier;
      settings.plex.name = result.MediaContainer.friendlyName;

      settings.save();
    }
  } catch (e) {
    return next({
      status: 500,
      message: `Failed to connect to Plex: ${e.message}`,
    });
  }

  return res.status(200).json(settings.plex);
});

settingsRoutes.get('/plex/status', async (req, res) => {
  const userRepository = getRepository(User);
  const settings = getSettings();
  try {
    const admin = await userRepository.findOneOrFail({
      select: ['id', 'plexToken'],
      order: { id: 'ASC' },
    });

    const plexClient = new PlexAPI({ plexToken: admin.plexToken });

    await plexClient.getStatus();

    const msg: PlexStatus = {
      settings: settings.plex,
      status: 200,
      message: 'OK',
    };
    return res.status(200).json(msg);
  } catch (e) {
    const msg: PlexStatus = {
      settings: settings.plex,
      status: 500,
      message: e.message,
    };
    return res.status(200).json(msg);
  }
});

settingsRoutes.post('/plex/status', async (req, res) => {
  const userRepository = getRepository(User);
  const settings = getSettings();
  try {
    const admin = await userRepository.findOneOrFail({
      select: ['id', 'plexToken'],
      order: { id: 'ASC' },
    });

    const plexDeviceSettings = {
      ...settings.plex,
      ...req.body,
    };

    const plexClient = new PlexAPI({
      plexToken: admin.plexToken,
      plexSettings: plexDeviceSettings,
    });

    await plexClient.getStatus();

    const msg: PlexStatus = {
      settings: settings.plex,
      status: 200,
      message: 'OK',
    };
    return res.status(200).json(msg);
  } catch (e) {
    const msg: PlexStatus = {
      settings: settings.plex,
      status: 500,
      message: e.message,
    };
    return res.status(200).json(msg);
  }
});

settingsRoutes.get('/plex/devices/servers', async (req, res, next) => {
  const userRepository = getRepository(User);
  const regexp = /(http(s?):\/\/)(.*)(:[0-9]*)/;
  try {
    const admin = await userRepository.findOneOrFail({
      select: ['id', 'plexToken'],
      order: { id: 'ASC' },
    });
    const plexTvClient = admin.plexToken
      ? new PlexTvAPI(admin.plexToken)
      : null;
    const devices = (await plexTvClient?.getDevices())?.filter((device) => {
      return device.provides.includes('server') && device.owned;
    });
    const settings = getSettings();
    if (devices) {
      await Promise.all(
        devices.map(async (device) => {
          await Promise.all(
            device.connection.map(async (connection) => {
              connection.host = connection.uri.replace(regexp, '$3');
              let msg:
                | { status: number; message: string }
                | undefined = undefined;
              const plexDeviceSettings = {
                ...settings.plex,
                ip: connection.host,
                port: connection.port,
                useSsl: connection.protocol === 'https' ? true : false,
              };
              const plexClient = new PlexAPI({
                plexToken: admin.plexToken,
                plexSettings: plexDeviceSettings,
                timeout: 5000,
              });
              try {
                await plexClient.getStatus();
                msg = {
                  status: 200,
                  message: 'OK',
                };
              } catch (e) {
                msg = {
                  status: 500,
                  message: e.message,
                };
              }
              connection.status = msg?.status;
              connection.message = msg?.message;
            })
          );
        })
      );
    }
    return res.status(200).json(devices);
  } catch (e) {
    return next({
      status: 500,
      message: `Failed to connect to Plex: ${e.message}`,
    });
  }
});

settingsRoutes.get('/plex/library', async (req, res) => {
  const settings = getSettings();

  if (req.query.sync) {
    const userRepository = getRepository(User);
    const admin = await userRepository.findOneOrFail({
      select: ['id', 'plexToken'],
      order: { id: 'ASC' },
    });
    const plexapi = new PlexAPI({ plexToken: admin.plexToken });

    const libraries = await plexapi.getLibraries();

    const newLibraries: Library[] = libraries
      // Remove libraries that are not movie or show
      .filter((library) => library.type === 'movie' || library.type === 'show')
      // Remove libraries that do not have a metadata agent set (usually personal video libraries)
      .filter((library) => library.agent !== 'com.plexapp.agents.none')
      .map((library) => {
        const existing = settings.plex.libraries.find(
          (l) => l.id === library.key && l.name === library.title
        );

        return {
          id: library.key,
          name: library.title,
          enabled: existing?.enabled ?? false,
        };
      });

    settings.plex.libraries = newLibraries;
  }

  const enabledLibraries = req.query.enable
    ? (req.query.enable as string).split(',')
    : [];
  settings.plex.libraries = settings.plex.libraries.map((library) => ({
    ...library,
    enabled: enabledLibraries.includes(library.id),
  }));
  settings.save();
  return res.status(200).json(settings.plex.libraries);
});

settingsRoutes.get('/plex/sync', (req, res) => {
  if (req.query.cancel) {
    jobPlexFullSync.cancel();
  } else if (req.query.start) {
    jobPlexFullSync.run();
  }
  return res.status(200).json(jobPlexFullSync.status());
});

settingsRoutes.get('/plex/devices', async (_req, res) => {
  const userRepository = getRepository(User);
  const admin = await userRepository.findOneOrFail({
    select: ['id', 'plexToken'],
    order: { id: 'ASC' },
  });
  const plexTVClient = new PlexTvAPI(admin.plexToken ?? '');
  return res.status(200).json(await plexTVClient.getDevices());
});

settingsRoutes.get('/radarr', (_req, res) => {
  const settings = getSettings();

  res.status(200).json(settings.radarr);
});

settingsRoutes.post('/radarr', (req, res) => {
  const settings = getSettings();

  const newRadarr = req.body as RadarrSettings;
  const lastItem = settings.radarr[settings.radarr.length - 1];
  newRadarr.id = lastItem ? lastItem.id + 1 : 0;

  // If we are setting this as the default, clear any previous defaults for the same type first
  // ex: if is4k is true, it will only remove defaults for other servers that have is4k set to true
  // and are the default
  if (req.body.isDefault) {
    settings.radarr
      .filter((radarrInstance) => radarrInstance.is4k === req.body.is4k)
      .forEach((radarrInstance) => {
        radarrInstance.isDefault = false;
      });
  }

  settings.radarr = [...settings.radarr, newRadarr];
  settings.save();

  return res.status(201).json(newRadarr);
});

settingsRoutes.post('/radarr/test', async (req, res, next) => {
  try {
    const radarr = new RadarrAPI({
      apiKey: req.body.apiKey,
      url: `${req.body.useSsl ? 'https' : 'http'}://${req.body.hostname}:${
        req.body.port
      }${req.body.baseUrl ?? ''}/api`,
    });

    const profiles = await radarr.getProfiles();
    const folders = await radarr.getRootFolders();

    return res.status(200).json({
      profiles,
      rootFolders: folders.map((folder) => ({
        id: folder.id,
        path: folder.path,
      })),
    });
  } catch (e) {
    logger.error('Failed to test Radarr', {
      label: 'Radarr',
      message: e.message,
    });

    next({ status: 500, message: 'Failed to connect to Radarr' });
  }
});

settingsRoutes.put<{ id: string }>('/radarr/:id', (req, res) => {
  const settings = getSettings();

  const radarrIndex = settings.radarr.findIndex(
    (r) => r.id === Number(req.params.id)
  );

  if (radarrIndex === -1) {
    return res
      .status(404)
      .json({ status: '404', message: 'Settings instance not found' });
  }

  // If we are setting this as the default, clear any previous defaults for the same type first
  // ex: if is4k is true, it will only remove defaults for other servers that have is4k set to true
  // and are the default
  if (req.body.isDefault) {
    settings.radarr
      .filter((radarrInstance) => radarrInstance.is4k === req.body.is4k)
      .forEach((radarrInstance) => {
        radarrInstance.isDefault = false;
      });
  }

  settings.radarr[radarrIndex] = {
    ...req.body,
    id: Number(req.params.id),
  } as RadarrSettings;
  settings.save();

  return res.status(200).json(settings.radarr[radarrIndex]);
});

settingsRoutes.get<{ id: string }>('/radarr/:id/profiles', async (req, res) => {
  const settings = getSettings();

  const radarrSettings = settings.radarr.find(
    (r) => r.id === Number(req.params.id)
  );

  if (!radarrSettings) {
    return res
      .status(404)
      .json({ status: '404', message: 'Settings instance not found' });
  }

  const radarr = new RadarrAPI({
    apiKey: radarrSettings.apiKey,
    url: `${radarrSettings.useSsl ? 'https' : 'http'}://${
      radarrSettings.hostname
    }:${radarrSettings.port}${radarrSettings.baseUrl ?? ''}/api`,
  });

  const profiles = await radarr.getProfiles();

  return res.status(200).json(
    profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
    }))
  );
});

settingsRoutes.delete<{ id: string }>('/radarr/:id', (req, res) => {
  const settings = getSettings();

  const radarrIndex = settings.radarr.findIndex(
    (r) => r.id === Number(req.params.id)
  );

  if (radarrIndex === -1) {
    return res
      .status(404)
      .json({ status: '404', message: 'Settings instance not found' });
  }

  const removed = settings.radarr.splice(radarrIndex, 1);
  settings.save();

  return res.status(200).json(removed[0]);
});

settingsRoutes.get('/sonarr', (_req, res) => {
  const settings = getSettings();

  res.status(200).json(settings.sonarr);
});

settingsRoutes.post('/sonarr', (req, res) => {
  const settings = getSettings();

  const newSonarr = req.body as SonarrSettings;
  const lastItem = settings.sonarr[settings.sonarr.length - 1];
  newSonarr.id = lastItem ? lastItem.id + 1 : 0;

  // If we are setting this as the default, clear any previous defaults for the same type first
  // ex: if is4k is true, it will only remove defaults for other servers that have is4k set to true
  // and are the default
  if (req.body.isDefault) {
    settings.sonarr
      .filter((sonarrInstance) => sonarrInstance.is4k === req.body.is4k)
      .forEach((sonarrInstance) => {
        sonarrInstance.isDefault = false;
      });
  }

  settings.sonarr = [...settings.sonarr, newSonarr];
  settings.save();

  return res.status(201).json(newSonarr);
});

settingsRoutes.post('/sonarr/test', async (req, res, next) => {
  try {
    const sonarr = new SonarrAPI({
      apiKey: req.body.apiKey,
      url: `${req.body.useSsl ? 'https' : 'http'}://${req.body.hostname}:${
        req.body.port
      }${req.body.baseUrl ?? ''}/api`,
    });

    const profiles = await sonarr.getProfiles();
    const folders = await sonarr.getRootFolders();

    return res.status(200).json({
      profiles,
      rootFolders: folders.map((folder) => ({
        id: folder.id,
        path: folder.path,
      })),
    });
  } catch (e) {
    logger.error('Failed to test Sonarr', {
      label: 'Sonarr',
      message: e.message,
    });

    next({ status: 500, message: 'Failed to connect to Sonarr' });
  }
});

settingsRoutes.put<{ id: string }>('/sonarr/:id', (req, res) => {
  const settings = getSettings();

  const sonarrIndex = settings.sonarr.findIndex(
    (r) => r.id === Number(req.params.id)
  );

  if (sonarrIndex === -1) {
    return res
      .status(404)
      .json({ status: '404', message: 'Settings instance not found' });
  }

  // If we are setting this as the default, clear any previous defaults for the same type first
  // ex: if is4k is true, it will only remove defaults for other servers that have is4k set to true
  // and are the default
  if (req.body.isDefault) {
    settings.sonarr
      .filter((sonarrInstance) => sonarrInstance.is4k === req.body.is4k)
      .forEach((sonarrInstance) => {
        sonarrInstance.isDefault = false;
      });
  }

  settings.sonarr[sonarrIndex] = {
    ...req.body,
    id: Number(req.params.id),
  } as SonarrSettings;
  settings.save();

  return res.status(200).json(settings.sonarr[sonarrIndex]);
});

settingsRoutes.delete<{ id: string }>('/sonarr/:id', (req, res) => {
  const settings = getSettings();

  const sonarrIndex = settings.sonarr.findIndex(
    (r) => r.id === Number(req.params.id)
  );

  if (sonarrIndex === -1) {
    return res
      .status(404)
      .json({ status: '404', message: 'Settings instance not found' });
  }

  const removed = settings.sonarr.splice(sonarrIndex, 1);
  settings.save();

  return res.status(200).json(removed[0]);
});

settingsRoutes.get('/jobs', (_req, res) => {
  return res.status(200).json(
    scheduledJobs.map((job) => ({
      name: job.name,
      nextExecutionTime: job.job.nextInvocation(),
    }))
  );
});

settingsRoutes.get(
  '/initialize',
  isAuthenticated(Permission.ADMIN),
  (_req, res) => {
    const settings = getSettings();

    settings.public.initialized = true;
    settings.save();

    return res.status(200).json(settings.public);
  }
);

settingsRoutes.get('/about', async (req, res) => {
  const mediaRepository = getRepository(Media);
  const mediaRequestRepository = getRepository(MediaRequest);

  const totalMediaItems = await mediaRepository.count();
  const totalRequests = await mediaRequestRepository.count();

  return res.status(200).json({
    version: getAppVersion(),
    totalMediaItems,
    totalRequests,
    tz: process.env.TZ,
  } as SettingsAboutResponse);
});

export default settingsRoutes;
