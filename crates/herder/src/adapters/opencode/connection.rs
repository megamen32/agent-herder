//! A single authenticated connection bound to one configured OpenCode instance.
//!
//! The connection reads OpenCode's generated API description before it is
//! exposed to operations. It never selects an instance from a global service
//! or follows a compatibility endpoint implicitly.

use std::{collections::HashMap, fmt, time::Duration};

use reqwest::{Client, Method, StatusCode, Url};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

use crate::{config::Profile, domain::address::InstanceRef};

const DESCRIPTION_PATH: &str = "openapi.json";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Credentials are supplied by the caller after resolving the profile's
/// protected secret reference. Debug output never includes the password.
#[derive(Clone)]
pub struct OpenCodeAuth {
    username: String,
    password: String,
}

impl OpenCodeAuth {
    pub fn new(username: impl Into<String>, password: impl Into<String>) -> Self {
        Self {
            username: username.into(),
            password: password.into(),
        }
    }
}

impl fmt::Debug for OpenCodeAuth {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OpenCodeAuth")
            .field("username", &self.username)
            .field("password", &"[REDACTED]")
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenCodeConnectionError {
    MissingEndpoint,
    InvalidEndpoint,
    Unauthorized,
    IncompatibleApi,
    HttpStatus(u16),
    Transport,
    InvalidDescription,
    InvalidRequestId,
    InvalidTimeout,
}

impl fmt::Display for OpenCodeConnectionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingEndpoint => f.write_str("OpenCode profile has no endpoint"),
            Self::InvalidEndpoint => f.write_str("OpenCode profile endpoint is invalid"),
            Self::Unauthorized => f.write_str("OpenCode endpoint rejected the configured identity"),
            Self::IncompatibleApi => {
                f.write_str("OpenCode endpoint lacks required session/event routes")
            }
            Self::HttpStatus(status) => write!(f, "OpenCode endpoint returned HTTP {status}"),
            Self::Transport => f.write_str("OpenCode endpoint could not be reached"),
            Self::InvalidDescription => {
                f.write_str("OpenCode endpoint returned an invalid API description")
            }
            Self::InvalidRequestId => f.write_str("OpenCode request ID must not be empty"),
            Self::InvalidTimeout => {
                f.write_str("OpenCode request timeout must be greater than zero")
            }
        }
    }
}

impl std::error::Error for OpenCodeConnectionError {}

/// API capabilities confirmed from this exact instance's OpenAPI document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenCodeApiDescription {
    pub openapi_version: String,
    pub has_session_list: bool,
    pub has_session_create: bool,
    pub has_event_stream: bool,
}

/// HTTP client and native identity for exactly one configured instance.
#[derive(Clone)]
pub struct OpenCodeConnection {
    instance: InstanceRef,
    endpoint: Url,
    client: Client,
    auth: Option<OpenCodeAuth>,
    api: OpenCodeApiDescription,
    request_timeout: Duration,
}

impl fmt::Debug for OpenCodeConnection {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OpenCodeConnection")
            .field("instance", &self.instance)
            .field("endpoint", &self.endpoint)
            .field("auth", &self.auth.as_ref().map(|_| "[CONFIGURED]"))
            .field("api", &self.api)
            .field("request_timeout", &self.request_timeout)
            .finish()
    }
}

#[derive(Deserialize)]
struct ApiDescriptionWire {
    openapi: String,
    paths: HashMap<String, HashMap<String, serde_json::Value>>,
}

impl OpenCodeConnection {
    /// Open the configured profile and verify its session and event routes.
    /// The only network request is a read-only GET of `openapi.json`.
    pub async fn open(
        instance: InstanceRef,
        profile: &Profile,
        auth: Option<OpenCodeAuth>,
    ) -> Result<Self, OpenCodeConnectionError> {
        let raw_endpoint = profile
            .endpoint
            .as_deref()
            .ok_or(OpenCodeConnectionError::MissingEndpoint)?;
        let endpoint =
            Url::parse(raw_endpoint).map_err(|_| OpenCodeConnectionError::InvalidEndpoint)?;
        if !matches!(endpoint.scheme(), "http" | "https")
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
        {
            return Err(OpenCodeConnectionError::InvalidEndpoint);
        }

        let client = Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .build()
            .map_err(|_| OpenCodeConnectionError::Transport)?;
        let connection = Self {
            instance,
            endpoint,
            client,
            auth,
            request_timeout: REQUEST_TIMEOUT,
            api: OpenCodeApiDescription {
                openapi_version: String::new(),
                has_session_list: false,
                has_session_create: false,
                has_event_stream: false,
            },
        };

        let description_url = connection
            .endpoint
            .join(DESCRIPTION_PATH)
            .map_err(|_| OpenCodeConnectionError::InvalidEndpoint)?;
        let mut request = connection
            .client
            .request(Method::GET, description_url)
            .timeout(CONNECT_TIMEOUT);
        if let Some(auth) = &connection.auth {
            request = request.basic_auth(&auth.username, Some(&auth.password));
        }
        let response = request
            .send()
            .await
            .map_err(|_| OpenCodeConnectionError::Transport)?;
        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err(OpenCodeConnectionError::Unauthorized);
        }
        if !response.status().is_success() {
            return Err(OpenCodeConnectionError::HttpStatus(
                response.status().as_u16(),
            ));
        }
        let wire: ApiDescriptionWire = response
            .json()
            .await
            .map_err(|_| OpenCodeConnectionError::InvalidDescription)?;

        let has_route = |path: &str, method: &str| {
            wire.paths
                .get(path)
                .is_some_and(|methods| methods.contains_key(method))
        };
        let api = OpenCodeApiDescription {
            openapi_version: wire.openapi,
            has_session_list: has_route("/api/session", "get"),
            has_session_create: has_route("/api/session", "post"),
            has_event_stream: has_route("/api/event", "get"),
        };
        if !api.has_session_list || !api.has_session_create || !api.has_event_stream {
            return Err(OpenCodeConnectionError::IncompatibleApi);
        }

        Ok(Self { api, ..connection })
    }

    pub fn instance(&self) -> &InstanceRef {
        &self.instance
    }

    pub fn api(&self) -> &OpenCodeApiDescription {
        &self.api
    }

    pub fn endpoint(&self) -> &Url {
        &self.endpoint
    }

    pub fn request_timeout(&self) -> Duration {
        self.request_timeout
    }

    pub fn with_request_timeout(
        mut self,
        timeout: Duration,
    ) -> Result<Self, OpenCodeConnectionError> {
        if timeout.is_zero() {
            return Err(OpenCodeConnectionError::InvalidTimeout);
        }
        self.request_timeout = timeout;
        Ok(self)
    }

    pub fn request(
        &self,
        request_id: impl Into<String>,
        method: Method,
        path: &str,
    ) -> Result<OpenCodeRequest, OpenCodeConnectionError> {
        let request_id = request_id.into();
        if request_id.trim().is_empty() {
            return Err(OpenCodeConnectionError::InvalidRequestId);
        }
        let relative = path
            .strip_prefix('/')
            .ok_or(OpenCodeConnectionError::InvalidEndpoint)?;
        if !relative.starts_with("api/") {
            return Err(OpenCodeConnectionError::InvalidEndpoint);
        }
        let url = self
            .endpoint
            .join(relative)
            .map_err(|_| OpenCodeConnectionError::InvalidEndpoint)?;
        let mut request = self.client.request(method, url);
        if let Some(auth) = &self.auth {
            request = request.basic_auth(&auth.username, Some(&auth.password));
        }
        Ok(OpenCodeRequest {
            request_id,
            request,
            timeout: self.request_timeout,
        })
    }
}

/// Transport outcome for one correlated native request. A timeout or an
/// interrupted response is uncertain and must be reconciled, never resent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenCodeRequestFailure {
    DefinitelyNotSent,
    OutcomeUnknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenCodeRequestError {
    pub request_id: String,
    pub failure: OpenCodeRequestFailure,
}

impl fmt::Display for OpenCodeRequestError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.failure {
            OpenCodeRequestFailure::DefinitelyNotSent => write!(
                f,
                "OpenCode request {} was not sent because the endpoint could not be reached",
                self.request_id
            ),
            OpenCodeRequestFailure::OutcomeUnknown => write!(
                f,
                "OpenCode request {} has an unknown outcome; reconcile its native receipt before any retry",
                self.request_id
            ),
        }
    }
}

impl std::error::Error for OpenCodeRequestError {}

/// Request builder that keeps its caller-supplied correlation ID through the
/// transport result and applies one bounded timeout without retrying. For
/// prompt mutations, the operation must also place the ID in the native prompt
/// `id` field; this local correlation value is not sent as an invented header.
pub struct OpenCodeRequest {
    request_id: String,
    request: reqwest::RequestBuilder,
    timeout: Duration,
}

impl OpenCodeRequest {
    pub fn json<T: Serialize + ?Sized>(mut self, body: &T) -> Self {
        self.request = self.request.json(body);
        self
    }

    pub async fn send(self) -> Result<OpenCodeResponse, OpenCodeRequestError> {
        let request_id = self.request_id;
        let response = self
            .request
            .timeout(self.timeout)
            .send()
            .await
            .map_err(|error| OpenCodeRequestError {
                request_id: request_id.clone(),
                failure: if error.is_connect() {
                    OpenCodeRequestFailure::DefinitelyNotSent
                } else {
                    OpenCodeRequestFailure::OutcomeUnknown
                },
            })?;
        Ok(OpenCodeResponse {
            request_id,
            response,
        })
    }
}

/// HTTP response tied to the request that produced it. HTTP status remains
/// visible to the operation layer; transport success is not business success.
pub struct OpenCodeResponse {
    request_id: String,
    response: reqwest::Response,
}

impl OpenCodeResponse {
    pub fn request_id(&self) -> &str {
        &self.request_id
    }

    pub fn status(&self) -> StatusCode {
        self.response.status()
    }

    pub async fn json<T: DeserializeOwned>(self) -> Result<T, OpenCodeRequestError> {
        let request_id = self.request_id;
        self.response
            .json()
            .await
            .map_err(|_| OpenCodeRequestError {
                request_id,
                failure: OpenCodeRequestFailure::OutcomeUnknown,
            })
    }
}
