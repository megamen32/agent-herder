//! Experimental request-authenticated HTTP transport. No authority or listener is
//! configured here; the embedding owner must supply both over trusted channels.
#[cfg(unix)]
pub mod authority_channel;
use axum::{
    Router,
    extract::{Request, State},
    http::{StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
};
use herder::{
    auth::identity::{ConnectionIdentity, OAuthAuthority, OAuthPolicy, authenticate_oauth_request},
    mcp::{catalog, transport::ApplicationPort},
};
use rmcp::{
    ErrorData, RoleServer, ServerHandler,
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, Implementation, ListToolsResult,
        PaginatedRequestParams, ProtocolVersion, ServerCapabilities, ServerConfig, Tool,
    },
    service::RequestContext,
    transport::streamable_http_server::{
        StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
    },
};
use serde_json::{Value, json};
use std::{borrow::Cow, sync::Arc};

#[derive(Clone)]
struct VerifiedRequest(ConnectionIdentity);
#[derive(Clone)]
struct AuthState {
    authority: Arc<dyn OAuthAuthority>,
    policy: OAuthPolicy,
}

async fn authorize(State(state): State<AuthState>, mut request: Request, next: Next) -> Response {
    if request
        .headers()
        .get_all(header::AUTHORIZATION)
        .iter()
        .count()
        != 1
    {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let token = match request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
    {
        Some(v) if !v.is_empty() && !v.contains(char::is_whitespace) => v,
        _ => return StatusCode::UNAUTHORIZED.into_response(),
    };
    let identity = match tokio::time::timeout(
        std::time::Duration::from_secs(3),
        authenticate_oauth_request(state.authority.as_ref(), token, &state.policy),
    )
    .await
    {
        Ok(Ok(value)) => value,
        _ => return StatusCode::UNAUTHORIZED.into_response(),
    };
    request.extensions_mut().insert(VerifiedRequest(identity));
    next.run(request).await
}

#[derive(Clone)]
struct HttpServer {
    app: Arc<dyn ApplicationPort>,
}
impl ServerHandler for HttpServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("agent-herder", "0.1.0"))
    }
    fn supported_protocol_versions(&self) -> Cow<'static, [ProtocolVersion]> {
        Cow::Borrowed(&[ProtocolVersion::V_2026_07_28])
    }
    async fn list_tools(
        &self,
        request: Option<PaginatedRequestParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        require_identity(&ctx)?;
        if request.and_then(|p| p.cursor).is_some() {
            return Err(ErrorData::invalid_params("unknown cursor", None));
        }
        let mut result = ListToolsResult::default();
        result.tools = catalog::discovery()
            .into_iter()
            .map(|d| {
                Tool::new(
                    d.name,
                    format!("Herder {} operation", d.name),
                    d.input_schema.as_object().expect("schema object").clone(),
                )
            })
            .collect();
        Ok(result)
    }
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let identity = require_identity(&ctx)?;
        if request.input_responses.is_some() || request.request_state.is_some() {
            return Err(ErrorData::invalid_params(
                "request continuation is unsupported",
                None,
            ));
        }
        let parsed = catalog::dispatch(
            &request.name,
            Value::Object(request.arguments.unwrap_or_default()),
        )
        .map_err(|_| ErrorData::invalid_params("unknown tool or invalid arguments", None))?;
        if matches!(
            &parsed.request,
            catalog::Request::Session(catalog::Session::Context { session_ref: None })
        ) {
            // OAuth identifies the account, not the conversation that invoked
            // the tool. An explicit target is authorized by the application;
            // it must not become a transport-verified self binding.
            return Ok(CallToolResult::structured_error(
                json!({"code":"self_binding_required","effect":"none"}),
            )
            .into());
        }
        Ok(self
            .app
            .call(identity, parsed.request)
            .await
            .unwrap_or_else(|| {
                CallToolResult::structured_error(json!({"code":"unsupported","effect":"none"}))
            })
            .into())
    }
}
fn require_identity(ctx: &RequestContext<RoleServer>) -> Result<&ConnectionIdentity, ErrorData> {
    ctx.extensions
        .get::<axum::http::request::Parts>()
        .and_then(|p| p.extensions.get::<VerifiedRequest>())
        .map(|v| &v.0)
        .ok_or_else(|| ErrorData::invalid_request("authenticated request context required", None))
}

/// Compose a fresh server with one trusted authority and application. All HTTP
/// methods pass the authority gate. MCP 2026-07-28 uses the sessionless lifecycle.
pub fn router(
    authority: Arc<dyn OAuthAuthority>,
    policy: OAuthPolicy,
    app: Arc<dyn ApplicationPort>,
) -> Router {
    let factory = move || Ok(HttpServer { app: app.clone() });
    let service: StreamableHttpService<HttpServer, LocalSessionManager> =
        StreamableHttpService::new(
            factory,
            Default::default(),
            StreamableHttpServerConfig::default()
                .with_json_response(true)
                .with_legacy_session_mode(false),
        );
    Router::new()
        .nest_service("/mcp", service)
        .layer(middleware::from_fn_with_state(
            AuthState { authority, policy },
            authorize,
        ))
}
