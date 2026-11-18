import { useEffect, useState } from 'react';
import { Button } from '@renderer/components/ui/button';
import { RefreshCcw } from 'lucide-react';
import { api } from '@/renderer/src/api';
import { toast } from 'sonner';

import { REPO_OWNER, REPO_NAME } from '@main/shared/constants';
import { WidgetOverlayMode } from '@main/store/types';
import { Switch } from '@renderer/components/ui/switch';
import { useSetting } from '@renderer/hooks/useSetting';

export const GeneralSettings = () => {
  const { settings, updateSetting } = useSetting();
  const [updateLoading, setUpdateLoading] = useState(false);
  const [overlaySaving, setOverlaySaving] = useState(false);
  const [keepWidgetOnTop, setKeepWidgetOnTop] = useState(true);
  const [updateDetail, setUpdateDetail] = useState<{
    currentVersion: string;
    version: string;
    link: string | null;
  } | null>();

  useEffect(() => {
    if (!Object.keys(settings).length) {
      return;
    }
    setKeepWidgetOnTop(
      settings.widgetOverlayMode !== WidgetOverlayMode.AllowCovered,
    );
  }, [settings]);

  const handleWidgetOverlayChange = async (checked: boolean) => {
    const previousValue = keepWidgetOnTop;
    setKeepWidgetOnTop(checked);
    setOverlaySaving(true);
    try {
      await updateSetting({
        ...settings,
        widgetOverlayMode: checked
          ? WidgetOverlayMode.AlwaysOnTop
          : WidgetOverlayMode.AllowCovered,
      });
      toast.success(
        checked
          ? 'Floating panel will stay on top when supported'
          : 'Fullscreen apps can cover the floating panel',
      );
    } catch (error) {
      setKeepWidgetOnTop(previousValue);
      console.error('Failed to update floating panel behavior:', error);
      toast.error('Failed to update floating panel behavior');
    } finally {
      setOverlaySaving(false);
    }
  };

  const handleCheckForUpdates = async () => {
    setUpdateLoading(true);
    try {
      const detail = await api.checkForUpdatesDetail();
      console.log('detail', detail);

      if (detail.updateInfo) {
        setUpdateDetail({
          currentVersion: detail.currentVersion,
          version: detail.updateInfo.version,
          link: `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/tag/v${detail.updateInfo.version}`,
        });
        return;
      } else if (!detail.isPackaged) {
        toast.info('Unpackaged version does not support update check!');
      } else {
        toast.success('No update available', {
          description: `current version: ${detail.currentVersion} is the latest version`,
          position: 'top-right',
          richColors: true,
        });
      }
    } catch (error) {
      console.error('Failed to check for updates:', error);
    } finally {
      setUpdateLoading(false);
    }
  };

  return (
    <>
      <div className="mb-6 flex items-center justify-between gap-6 rounded-lg border p-4">
        <div>
          <p className="font-medium">Keep floating panel on top</p>
          <p className="text-sm text-muted-foreground">
            Uses the highest topmost layer supported by Electron. Fully
            exclusive fullscreen apps may still cover the panel.
          </p>
        </div>
        <Switch
          aria-label="Keep floating panel on top"
          checked={keepWidgetOnTop}
          disabled={overlaySaving}
          onCheckedChange={handleWidgetOverlayChange}
        />
      </div>
      <Button
        variant="outline"
        type="button"
        disabled={updateLoading}
        onClick={handleCheckForUpdates}
      >
        <RefreshCcw
          className={`h-4 w-4 mr-2 ${updateLoading ? 'animate-spin' : ''}`}
        />
        {updateLoading ? 'Checking...' : 'Check Updates'}
      </Button>
      {updateDetail?.version && (
        <div className="text-sm text-gray-500">
          {`${updateDetail.currentVersion} -> ${updateDetail.version}(latest)`}
        </div>
      )}
      {updateDetail?.link && (
        <div className="text-sm text-gray-500">
          Release Notes:{' '}
          <a
            href={updateDetail.link}
            target="_blank"
            className="underline"
            rel="noreferrer"
          >
            {updateDetail.link}
          </a>
        </div>
      )}
    </>
  );
};
