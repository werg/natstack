# Plan / Requirements for permissions

- Control browser panels via playwright
  - default: not allowed
  - whitelist for certain domains
- Access to git subpaths
- nango / oauth access
- access to unsafe agents (maybe instead make unsafe per se panels)
- URL / cookie access -- for now browser panels are not partitioned, but we should actually make them partitioned by default and then have permissions to access the root partition state
Allow for navigator.permissions.query({ name: "foobar" })