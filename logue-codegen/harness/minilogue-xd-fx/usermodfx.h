#pragma once
#include "fx_host.h"
typedef enum { k_user_modfx_param_time = 0, k_user_modfx_param_depth, k_num_user_modfx_param_id } user_modfx_param_id_t;
#define MODFX_INIT _hook_init
#define MODFX_PROCESS _hook_process
#define MODFX_SUSPEND _hook_suspend
#define MODFX_RESUME _hook_resume
#define MODFX_PARAM _hook_param
