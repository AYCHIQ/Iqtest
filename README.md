# iq-test
Automatic load test for Axxonsoft Intellect
## Running test
```
node test-runner.js --ip 192.168.10.10 --host SERVER --wsauth admin:admin
```
### Parameters
| Parameter | Description | required? |
|-----------|-------------|----------|
| `--ip <ip>` | IP address of Intellect server | o |
| `--host <host>` | Server name specified in Intellect configuration | o |
| `--wsauth <user:pass>`| Credential to access WS-Man | o |
| `--interval <seconds>` | Interval for Video statistics reports | |
| `--iidk <id>` | Id of IIDK interface object used for connection | |
| `--cams <number>` | Initial number of cameras to create | |
| `--stream <rtsp://uri>` | RTSP URI used for camera streams | |
| `--stop 0` | Don't stop running modules after the test | |

Default values are loaded from `config.json` file.
