from __future__ import annotations

from pydantic import BaseModel, Field


class EnvironmentDevice(BaseModel):
    ip: str
    type: str = ""


class EnvironmentConfig(BaseModel):
    environmentId: str
    jobName: str
    displayName: str = ""
    testBedIp: str
    envFile: str
    slaveId: str = ""
    neDevices: list[EnvironmentDevice] = Field(default_factory=list)


class EnvironmentSignal(BaseModel):
    source: str
    status: str
    severity: str = "unknown"
    summary: str = ""
    detail: dict = Field(default_factory=dict)


class EnvironmentSession(BaseModel):
    targetIp: str
    user: str = ""
    sourceIp: str = ""
    protocol: str = ""
    since: str = ""
    raw: str = ""


class EnvironmentStatus(BaseModel):
    environmentId: str
    jobName: str
    displayName: str
    testBedIp: str
    envFile: str
    neDevices: list[EnvironmentDevice] = Field(default_factory=list)
    status: str
    severity: str
    summary: str
    updatedAt: str
    signals: list[EnvironmentSignal] = Field(default_factory=list)
    neSessions: list[EnvironmentSession] = Field(default_factory=list)


class SlaveCapabilities(BaseModel):
    browseRobotRoot: bool = True
    runRobot: bool = True
    svnOps: bool = False
    processInspect: bool = True
    terminal: bool = True
    killProcess: bool = True


class SlaveInfo(BaseModel):
    slaveId: str
    name: str
    host: str
    system: str
    connectionMode: str = "remote-agent"
    agentVersion: str = ""
    pythonVersion: str = ""
    robotVersion: str = ""
    mode: str = "offline"
    holder: str = ""
    holderEmail: str = ""
    heartbeatAt: str = ""
    expiresAt: str = ""
    manualHoldReason: str = ""
    activeRunId: str = ""
    processSignal: str = "none"
    jenkinsJob: str = ""
    allowedRoots: list[str] = Field(default_factory=list)
    capabilities: SlaveCapabilities = Field(default_factory=SlaveCapabilities)


class LoginRequest(BaseModel):
    email: str
    password: str


class AuthUserResponse(BaseModel):
    email: str
    displayName: str
    roles: list[str] = Field(default_factory=list)


class LockRequest(BaseModel):
    manualHoldReason: str = ""


class TakeoverRequest(BaseModel):
    reason: str = ""


class TerminalSessionResponse(BaseModel):
    id: str
    slaveId: str
    shell: str
    readOnly: bool = False


class FileEntry(BaseModel):
    name: str
    type: str
    size: int
    permissions: str = ""
    owner: str = ""
    group: str = ""
    modified: float = 0
    path: str


class FileListResponse(BaseModel):
    files: list[FileEntry]
    cwd: str


class FileReadResponse(BaseModel):
    content: str
    size: int
    encoding: str = "utf-8"


class FileWriteRequest(BaseModel):
    path: str
    content: str
    encoding: str = "utf-8"


class FileMkdirRequest(BaseModel):
    path: str
    parents: bool = False
