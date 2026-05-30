{
  config,
  lib,
  pkgs,
  ...
}: let
  cfg = config.services.configarr;
  yamlFormat = pkgs.formats.yaml {};
  # Render to YAML, then post-process to unquote YAML tags like `!env FOO` or
  # `!secret BAR` that yaml.dump emits as quoted strings. Same approach used by
  # the home-assistant NixOS module.
  configFile = pkgs.runCommand "configarr-config.yml" {preferLocalBuilds = true;} ''
    cp ${yamlFormat.generate "config.yml" cfg.config} $out
    sed -i -e "s/'\!\([a-z_]\+\) \(.*\)'/\!\1 \2/;s/^\!\!/\!/;" $out
  '';
in {
  config = lib.mkIf cfg.enable {
    systemd = {
      services.configarr = {
        after = [
          "network-online.target"
          "systemd-tmpfiles-setup.service"
        ];
        description = "Run Configarr (packaged) once";
        path = [pkgs.git];
        preStart = ''
          echo "Creating configarr config file at ${cfg.dataDir}/config/"
          install -D -m 0644 ${configFile} ${cfg.dataDir}/config/config.yml
          chown ${cfg.user}:${cfg.group} ${cfg.dataDir}/config/config.yml
          echo "Created configarr config file at ${cfg.dataDir}/config/"
        '';
        serviceConfig = {
          EnvironmentFile = lib.optional (cfg.environmentFile != null) cfg.environmentFile;
          ExecStart = let
            pkg =
              if (cfg.package != null)
              then cfg.package
              else (import ../package.nix {inherit lib pkgs;});
          in
            lib.getExe pkg;
          Group = cfg.group;
          Type = "oneshot";
          User = cfg.user;
          WorkingDirectory = cfg.dataDir;
        };
        wants = ["network-online.target"];
      };

      timers.configarr = {
        description = "Schedule Configarr run";
        partOf = ["configarr.service"];
        timerConfig = {
          OnCalendar = cfg.schedule;
          Persistent = true;
          RandomizedDelaySec = "5m";
        };
        wantedBy = ["timers.target"];
      };

      tmpfiles.rules = [
        "d ${cfg.dataDir} 0755 ${cfg.user} ${cfg.group} -"
        "d ${cfg.dataDir}/config 0755 ${cfg.user} ${cfg.group} -"
      ];
    };

    users = {
      groups = lib.mkIf (cfg.group == "configarr") {
        ${cfg.group} = {};
      };

      users = lib.mkIf (cfg.user == "configarr") {
        configarr = {
          description = "configarr user";
          inherit (cfg) group;
          home = cfg.dataDir;
          isSystemUser = true;
        };
      };
    };
  };
}
